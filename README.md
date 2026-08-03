# SQL Management

SQL Management is a self-hosted browser interface for working with Microsoft SQL Server and PostgreSQL. It combines everyday querying, schema exploration, connection profiles, and side-by-side comparison in one lightweight Node.js application.

> [!IMPORTANT]
> SQL Management's HTTP API has no user authentication and uses the database credentials configured in the running server. Keep the default loopback binding unless you place it behind appropriate network and authentication controls.
>
> When several people share one server, each browser gets its own connections (tracked by a `sqlmgmt_sid` session cookie), so switching server or profile affects only the person who did it. That is isolation, not access control — anyone who can reach the API gets a session and the configured credentials with it.

## Features

- SQL Server, PostgreSQL, and split-view workspaces.
- Multiple connection panes with saved browser profiles and per-profile read-only mode.
- Server-enforced read-only profiles for query execution.
- Schema browsing for tables, views, columns, procedures, and PostgreSQL functions.
- Query tabs, per-database auto-save, history, snippets, and saved-query tools.
- Quote- and comment-aware multi-statement batches with per-statement results.
- Side-by-side result comparison, including positional and key-column matching.
- Result filtering, column statistics, resizable columns, and row counts.
- CSV and JSON copy/download, charting, and query-plan tools.
- Paste tabular data as SQL `VALUES`, copy rows as `INSERT`, and inspect compressed values.
- Cross-database schema diff, query cancellation, hard timeouts, and local audit logs.
- Dark, light, and system themes.

## Requirements

- Node.js 18 or later.
- Network access and credentials for SQL Server, PostgreSQL, or both.
- A modern browser.

## Quick start

```powershell
git clone https://github.com/WongKaiSung/sql-management.git
cd sql-management
npm ci
Copy-Item .env.example .env
npm start
```

On macOS or Linux, use `cp .env.example .env` instead of `Copy-Item`.

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The application can start with only one database engine configured; fill in the relevant values in `.env` or connect through the interface.

## Configuration

SQL Management reads `.env` directly at startup. The file is ignored by Git. These variables are available:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP bind address. Keep loopback unless access is protected. |
| `PORT` | `3000` | HTTP port. |
| `QUERY_TIMEOUT_MS` | `60000` | Hard query timeout in milliseconds. |
| `AUDIT_QUERY_MAX` | `4000` | Maximum query-text characters written to each audit entry. |
| `MSSQL_SERVER` | `localhost` | Initial SQL Server host or instance. |
| `MSSQL_USER` | `sa` | Initial SQL Server username. |
| `MSSQL_PASSWORD` | empty | Initial SQL Server password. |
| `MSSQL_DEFAULT_DB` | empty | Database selected on first load when no per-profile choice exists. |
| `MSSQL_ENCRYPT` | `false` | Enable SQL Server transport encryption. |
| `MSSQL_TRUST_SERVER_CERT` | `true` | Trust an unverified SQL Server certificate. Set `false` with a valid production certificate. |
| `PG_HOST` | `localhost` | Initial PostgreSQL host. |
| `PG_PORT` | `5432` | Initial PostgreSQL port. |
| `PG_USER` | `postgres` | Initial PostgreSQL username. |
| `PG_PASSWORD` | empty | Initial PostgreSQL password. |
| `PG_DEFAULT_DB` | empty | Database selected on first load when no per-profile choice exists. |

Startup values are defaults for this single server process. Connection settings can be changed at runtime from each pane. Saved profiles, including their passwords, are stored in the current browser's localStorage.

## Query behavior

- Clicking a table generates and immediately runs a limited `SELECT` for the pane's database engine.
- SQL Server batches execute each parsed statement independently. Use an explicit transaction inside one statement when atomicity is required.
- PostgreSQL batches run in a server-managed transaction and roll back on a mid-batch error.
- Read-only profiles reject non-`SELECT` statements on the server.
- Destructive-query prompts in the browser are advisory and can be bypassed by direct API calls.
- The timeout applies to both database engines. Running queries can also be cancelled from the UI.

## Security and privacy

This project is intended for one trusted operator per running instance.

- **No application authentication:** anyone who can reach the HTTP port can call the API with the configured database access. Leave `HOST=127.0.0.1`, or use an authenticated reverse proxy and trusted network controls.
- **Database permissions remain decisive:** use separate least-privilege database accounts. A read-only profile adds server-side statement enforcement but does not replace database-level permissions.
- **Browser storage contains sensitive data:** saved connection profiles can include passwords, and query history can contain confidential SQL or values. Use a trusted browser profile and clear its site data when appropriate.
- **Audit logs contain SQL text:** every query creates a JSON-line record under `logs/`. Restrict filesystem access and define retention and secure-deletion practices suitable for your data.
- **TLS defaults favor local development:** review `MSSQL_ENCRYPT`, `MSSQL_TRUST_SERVER_CERT`, database transport encryption, and reverse-proxy TLS before production use.
- **Do not expose the Node process directly to the internet.** This application is not designed as a multi-user hosted SQL service.

Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## Development

There is no frontend build step. The Express server serves a single-page application with local vendor assets.

```powershell
npm run check
npm test
pnpm audit --prod
```

The test suite uses Node's built-in test runner. `npm run check` validates the server and shared browser helper syntax.

## Deployment

- [Docker hosting guide](deploy/DOCKER-HOSTING-GUIDE.md)
- [IIS hosting guide](deploy/IIS-HOSTING-GUIDE.md)

Because connection state is process-global, run a separate instance for each trusted operator or isolated environment.

## License

SQL Management is available under the [MIT License](LICENSE).
