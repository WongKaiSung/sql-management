# Hosting SQLConnect on IIS with iisnode

IIS runs `node.exe` in-process through the **iisnode** module. Incoming requests
are rewritten to `server.js`, and Express serves both the `/api` routes and the
static UI from `public/`. Your `server.js` does not need changes — it already
falls back to listening on the named pipe that iisnode provides (the
`isNaN(parseInt(PORT))` branch in `server.js`).

```
  Browser ──HTTP/HTTPS──▶  IIS site (:80/:443)
                              │  iisnode module + URL Rewrite
                              ▼
                          node.exe  server.js  (named pipe, managed by IIS)
```

> Heads-up: iisnode is older and less actively maintained than running Node as a
> standalone service behind an IIS reverse proxy (ARR). It works fine for a
> single-tenant tool like this, but if you hit module/version friction, the
> reverse-proxy approach is the common fallback.

---

## 1. Install prerequisites on the server (one-time)

1. **Node.js** (matches `engines.node >= 18` in package.json) — verify `node -v`.
2. **IIS** with these features (Server Manager ▸ Add Roles, or *Turn Windows
   features on/off*):
   - Web Server (IIS) ▸ Web Server ▸ Common HTTP Features
   - Web Server (IIS) ▸ Management Tools ▸ IIS Management Console
3. **iisnode** module — install the x64 build that matches your IIS:
   https://github.com/Azure/iisnode/releases (`iisnode-full-iis7-v*-x64.msi`).
4. **URL Rewrite 2.1** —
   https://www.iis.net/downloads/microsoft/url-rewrite

After installing, run `iisreset`.

> The `web.config` in `D:\KS\SQL` already wires up the iisnode handler and the
> rewrite rules — you don't edit it for a basic deploy.

---

## 2. Prepare the app

From a normal prompt in `D:\KS\SQL`:

```powershell
npm install                 # if node_modules isn't already present
copy .env.example .env      # then edit .env with real connection settings
```

`.env` notes for production:
- You can drop `HOST`/`PORT` — under iisnode, IIS injects `PORT` (a named pipe)
  and `server.js` listens on it automatically. Setting `HOST`/`PORT` in `.env`
  is harmless because iisnode's injected `PORT` takes precedence.
- Set `MSSQL_TRUST_SERVER_CERT=false` and real credentials for production.

---

## 3. Create the IIS site + app pool

Run the helper from an **elevated** PowerShell (it creates the app pool as
*No Managed Code*, creates the website, and grants the permissions iisnode
needs to write its logs):

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\setup-iis-site.ps1 `
    -SiteName "SQLConnect" -HostName "sql.yourcompany.local" -Port 80
```

Or do it by hand in **IIS Manager**:

1. **Application Pools** ▸ **Add Application Pool…** — name `SQLConnect`,
   **.NET CLR version: No Managed Code**, pipeline Integrated.
2. **Sites** ▸ **Add Website…** — name `SQLConnect`, physical path `D:\KS\SQL`,
   app pool `SQLConnect`, binding `http` on port `80` (host name optional).
3. Grant the app-pool identity (`IIS AppPool\SQLConnect`) **read+execute** on
   `D:\KS\SQL` and **modify** on `D:\KS\SQL\logs` and `D:\KS\SQL\iisnode`
   (iisnode writes stdout/stderr logs there).

Browse to the site. You should see the SQLConnect UI.

---

## 4. Why one Node process (important for this app)

SQLConnect keeps its connection state in **module-global variables**
(`mssqlConfig`, `pgConfig`, read-only flags). If IIS ran more than one Node
process for the site, each would hold its own connection state and IIS would
round-robin requests between them — so a connection you set up could "vanish"
on the next request.

The `web.config` therefore pins `nodeProcessCountPerApplication="1"`. Leave it
at 1. For the same reason the app pool is set to a single worker (the default)
— don't enable a web garden.

---

## 5. Add HTTPS and access control (recommended)

The API has **no authentication**; server-enforced read-only profiles are the
only safety boundary. Don't expose it on a network without TLS and access
control.

1. Import a certificate (IIS Manager ▸ server ▸ **Server Certificates**).
2. Site ▸ **Bindings…** ▸ **Add** ▸ `https`, port `443`, select the cert.
3. Optionally force HTTPS (a rewrite redirect rule, or site ▸ **HSTS…** on
   IIS 10).
4. Restrict reach: **IP Address and Domain Restrictions**, Windows
   Authentication, or a VPN. IIS auth runs before the request reaches Node, so
   you can layer it on without touching the app.

---

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **HTTP 500.1001 / "iisnode … cannot be found"** | iisnode module not installed, or 32/64-bit mismatch with the app pool. Reinstall the x64 msi; ensure the pool isn't set to "Enable 32-bit Applications". |
| **500.19 reading web.config** | URL Rewrite module not installed (config references its `<rewrite>` section). Install it, then `iisreset`. |
| **502 / "The iisnode module failed to load node.exe"** | `node.exe` not on PATH for the app-pool identity. Either add Node to the *system* PATH, or set `nodeProcessCommandLine="C:\Program Files\nodejs\node.exe"` in the `<iisnode>` element. |
| **403 / can't write logs** | App-pool identity lacks write on `logs\` and `iisnode\`. Re-run the grant in step 3. |
| **App loads but DB calls fail** | `.env` missing/incorrect, or the app-pool identity can't reach SQL Server/PG. Check `iisnode\*.log` and `logs\audit-*.log`. |
| **Connection "resets" between requests** | More than one Node process — confirm `nodeProcessCountPerApplication="1"` and no web garden. |
| **Long queries time out at IIS** | iisnode/IIS request timeout shorter than `QUERY_TIMEOUT_MS`. Lengthen via `<iisnode requestTimeout="…">` (ms) and the app pool's request limits if needed. |

Logs to check first: `D:\KS\SQL\iisnode\*.log` (Node stdout/stderr captured by
iisnode) and `D:\KS\SQL\logs\audit-YYYY-MM-DD.log` (the app's per-query audit
log).

---

## Files in this deploy

- `..\web.config` — iisnode handler + rewrite rules + single-process pin (sits in the site root, `D:\KS\SQL`).
- `setup-iis-site.ps1` — creates the app pool/site and grants iisnode the file permissions it needs.
- `IIS-HOSTING-GUIDE.md` — this guide.
