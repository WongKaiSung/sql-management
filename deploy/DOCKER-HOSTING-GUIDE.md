# Hosting SQL Management with Docker

The app is a single Node/Express process serving the `/api` routes and the
static UI in `public/`. The image runs `node server.js` directly — no IIS,
no iisnode. Connection settings come from environment variables.

```
  Browser ──HTTP──▶  published port (:3000)
                        │
                        ▼
                   node.exe → server.js  (HOST=0.0.0.0 inside the container)
```

> The container sets `HOST=0.0.0.0` so the app is reachable through the
> published port. (The app defaults to `127.0.0.1`, which would only be
> reachable from inside the container.)

---

## Files

- `../Dockerfile` — builds the image (Node 22 Alpine, prod deps only, tini for clean shutdown).
- `../.dockerignore` — keeps `node_modules`, `.env`, logs, and deploy/IIS files out of the build context.
- `../docker-compose.yml` — one-command run with env vars, port mapping, and a volume for the audit log.

---

## 1. Build

From the project root (`D:\KS\SQL`):

```powershell
docker build -t dualsql:latest .
```

## 2. Run

### Option A — docker compose (recommended)

Set your DB credentials, then bring it up:

```powershell
# Pass secrets via the environment (compose substitutes them; see docker-compose.yml).
$env:MSSQL_SERVER   = "host.docker.internal"
$env:MSSQL_USER     = "sa"
$env:MSSQL_PASSWORD = "your-strong-password"
$env:PG_HOST        = "host.docker.internal"
$env:PG_PASSWORD    = "your-pg-password"

docker compose up -d --build
```

Or put the same keys in a `.env` file next to `docker-compose.yml` — compose
reads it automatically. (`.env` is gitignored and excluded from the image.)

### Option B — docker run

```powershell
docker run -d --name dualsql -p 3000:3000 `
  --add-host host.docker.internal:host-gateway `
  -e MSSQL_SERVER=host.docker.internal -e MSSQL_USER=sa -e MSSQL_PASSWORD=... `
  -e PG_HOST=host.docker.internal -e PG_USER=postgres -e PG_PASSWORD=... `
  -v ${PWD}\logs:/app/logs `
  dualsql:latest
```

Browse to **http://localhost:3000**.

---

## 3. Reaching your databases

- **DB on the same host as Docker** → use `host.docker.internal` as the server
  name (already the default in `docker-compose.yml`). The compose file adds the
  `host-gateway` mapping so this works on Linux too.
- **DB in another container** → put both on the same Docker network and use the
  DB container's service name as the host.
- **Remote DB** → just use its real hostname/IP; nothing special needed.

---

## 4. Operations

```powershell
docker compose logs -f          # follow stdout (startup banner, errors)
docker compose restart          # restart the app
docker compose down             # stop and remove the container
docker compose up -d --build    # rebuild + redeploy after code changes
```

The per-query audit log is written to `./logs/audit-YYYY-MM-DD.log` on the host
via the mounted volume. Graceful shutdown (pool close) works because `tini` is
PID 1 and forwards `SIGTERM` to Node.

---

## 4b. Deploy to another Windows PC (copy + build there)

1. **On the target PC, install Docker Desktop** and start it (uses the WSL2
   backend; accept the prompt to install WSL if asked). Confirm with
   `docker version` in PowerShell.
2. **Copy the project folder** to the target (e.g. to `C:\apps\SQL`). You can
   skip `node_modules` and `logs` — they're rebuilt/recreated. The simplest is
   to zip the folder *without* `node_modules`, copy the zip, and unzip on the
   target.
3. **Create `.env`** in that folder with the real DB credentials (see below).
4. In PowerShell, from the project folder:
   ```powershell
   docker compose up -d --build
   ```
5. Browse **http://localhost:3000** on the target. To reach it from *other*
   machines, use `http://<target-pc-ip>:3000` and allow the port through
   Windows Firewall:
   ```powershell
   New-NetFirewallRule -DisplayName "SQL Management 3000" -Direction Inbound `
     -Protocol TCP -LocalPort 3000 -Action Allow
   ```

### Important: where are your databases?

`host.docker.internal` resolves to **the target PC's own host**, not your old
machine. Set the DB hosts to wherever the databases actually live, reachable
*from the target PC*:

- DB runs **on the target PC itself** → keep `host.docker.internal`.
- DB runs on a **server / another machine** → set `MSSQL_SERVER` / `PG_HOST`
  to that machine's hostname or IP.

A `.env` for the target might look like:

```
MSSQL_SERVER=dbserver.corp.local
MSSQL_USER=sa
MSSQL_PASSWORD=your-strong-password
MSSQL_TRUST_SERVER_CERT=false
PG_HOST=dbserver.corp.local
PG_USER=postgres
PG_PASSWORD=your-pg-password
```

## 5. Production notes

- **No authentication.** The API has no auth; server-enforced read-only profiles
  are the only safety boundary. Don't publish port 3000 to an untrusted network.
  Put it behind a reverse proxy (nginx/Caddy/Traefik) that terminates TLS and
  adds access control, or restrict it to a VPN/private subnet.
- **TLS** is best handled at the reverse proxy, not in the app.
- Set `MSSQL_TRUST_SERVER_CERT=false` and real credentials for production.
- Pass passwords as environment variables or Docker secrets — don't bake them
  into the image.
- The app keeps connection state in module-global variables, so run a **single
  replica**. Don't scale this service to multiple containers behind a load
  balancer, or connection state will appear to "vanish" between requests.
