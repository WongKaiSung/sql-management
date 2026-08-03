const express = require('express');
const sql = require('mssql');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns').promises;
const pkg = require('./package.json');

const WORKSTATION = os.hostname();

// Reverse-DNS for pg_stat_activity client_addr, so the clients panel can name
// the machine behind an IP. Lookups run in the background and the result is
// cached — /api/status is polled continuously and must never block on DNS, so a
// first sighting returns null and the name lands on a later poll. Failures (no
// PTR record — common for Linux hosts and containers) are cached as null too,
// otherwise every poll would re-query DNS for them.
const RDNS_TTL_MS = 30 * 60 * 1000;
const rdnsCache = new Map();    // ip → { host: string|null, at: epoch ms }
const rdnsInFlight = new Set();

// Which resolver answers a PTR query is platform-dependent, and getting it wrong
// silently yields no hostnames at all:
//   - Windows: the OS resolver picks the nameserver that actually serves the
//     private zone, so getnameinfo (dns.lookupService) works. Bare c-ares
//     (dns.reverse) does not — it walks resolv.conf in order and stops on the
//     first NXDOMAIN, which a public resolver returns instantly.
//   - musl/Alpine (the container): getnameinfo queries every nameserver
//     concurrently and takes the first reply, so a public resolver's NXDOMAIN
//     beats the internal server and hostnames never resolve.
// RDNS_SERVERS pins lookups to the internal DNS, bypassing resolv.conf and its
// ordering rules entirely. Unset, we fall back to the OS resolver.
// Resolved lazily: .env is loaded further down, so process.env is not populated
// at module-evaluation time.
let rdnsResolver;               // undefined = not yet initialised, null = none

function getRdnsResolver() {
  if (rdnsResolver !== undefined) return rdnsResolver;
  const servers = (process.env.RDNS_SERVERS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!servers.length) return (rdnsResolver = null);
  const r = new dns.Resolver();
  r.setServers(servers);
  return (rdnsResolver = r);
}

function rdnsLookup(ip) {
  const hit = rdnsCache.get(ip);
  if (hit && Date.now() - hit.at < RDNS_TTL_MS) return hit.host;
  if (!rdnsInFlight.has(ip)) {
    rdnsInFlight.add(ip);
    const resolver = getRdnsResolver();
    const pending = resolver
      ? resolver.reverse(ip).then(names => names[0] || null)
      : dns.lookupService(ip, 0).then(r => r.hostname || null);
    pending
      .then(host => rdnsCache.set(ip, { host: host || null, at: Date.now() }))
      .catch(() => rdnsCache.set(ip, { host: null, at: Date.now() }))
      .finally(() => rdnsInFlight.delete(ip));
  }
  return hit ? hit.host : null;   // serve the stale name while it refreshes
}

// Load .env if present (no dotenv dependency)
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
      }
    });
  }
} catch {}

const app = express();
app.use(express.json({ limit: '50mb' }));

function packageRoot(name) {
  let dir = path.dirname(require.resolve(name));
  while (dir !== path.dirname(dir) && !fs.existsSync(path.join(dir, 'package.json'))) {
    dir = path.dirname(dir);
  }
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    throw new Error(`Package root not found: ${name}`);
  }
  return dir;
}

const codeMirrorRoot = packageRoot('codemirror');
const codeMirrorBrowserAliases = new Map([
  ['lib/codemirror.min.css', 'lib/codemirror.css'],
  ['theme/dracula.min.css', 'theme/dracula.css'],
  ['theme/eclipse.min.css', 'theme/eclipse.css'],
  ['lib/codemirror.min.js', 'lib/codemirror.js'],
  ['mode/sql/sql.min.js', 'mode/sql/sql.js'],
  ['addon/edit/matchbrackets.min.js', 'addon/edit/matchbrackets.js'],
  ['addon/display/placeholder.min.js', 'addon/display/placeholder.js'],
  ['addon/comment/comment.min.js', 'addon/comment/comment.js'],
]);
for (const [requestPath, sourcePath] of codeMirrorBrowserAliases) {
  app.get(`/vendor/codemirror/${requestPath}`, (req, res, next) => {
    res.sendFile(path.join(codeMirrorRoot, sourcePath), error => {
      if (error) next(error);
    });
  });
}

app.use('/vendor/codemirror', express.static(codeMirrorRoot));
app.use('/vendor/sql-formatter', express.static(packageRoot('sql-formatter')));
app.use('/vendor/chart.js', express.static(packageRoot('chart.js')));
// HTML (and build.txt) must never be served stale — the caching reverse proxy /
// browser otherwise keeps the old index.html after a redeploy, so new features
// "don't appear". no-cache still allows ETag revalidation (cheap 304s).
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('.txt')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Never cache API responses. Behind a caching reverse proxy (the dockerized
// deployment sits behind one; direct localhost does not), a cached /databases or
// /tables response is served after a connection switch, so the UI shows the
// previous connection's data. no-store on every /api response prevents that.  (no API caching)
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Each browser gets its own connection state — see the "Per-browser sessions"
// block below for why. Scoped to /api deliberately: the session cookie must only
// ride on responses the no-store header above forbids anyone from caching. Put
// it on a cacheable static asset and a shared reverse proxy could store that
// response and hand one person's session id to everybody behind it.
app.use('/api', attachSession);

const QUERY_TIMEOUT_MS = parseInt(process.env.QUERY_TIMEOUT_MS) || 60000;
const AUDIT_LOG_DIR = path.join(__dirname, 'logs');
const AUDIT_QUERY_MAX = parseInt(process.env.AUDIT_QUERY_MAX) || 4000;

try { fs.mkdirSync(AUDIT_LOG_DIR, { recursive: true }); } catch {}

function auditLog(entry) {
  try {
    const ts = new Date();
    const date = ts.toISOString().slice(0, 10);
    const file = path.join(AUDIT_LOG_DIR, `audit-${date}.log`);
    const q = String(entry.query || '');
    const truncated = q.length > AUDIT_QUERY_MAX;
    const line = JSON.stringify({
      ts: ts.toISOString(),
      workstation: WORKSTATION,
      osUser: process.env.USERNAME || process.env.USER || null,
      ...entry,
      query: truncated ? q.slice(0, AUDIT_QUERY_MAX) + `…[+${q.length - AUDIT_QUERY_MAX} chars]` : q,
    }) + '\n';
    fs.appendFile(file, line, () => {});
  } catch {}
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

// Splits a SQL batch on top-level `;`. Aware of:
//   '...' single-quoted strings (with '' escape)
//   "..." double-quoted identifiers (with "" escape)
//   [...] bracket-quoted identifiers (MSSQL, with ]] escape)
//   --   line comments through end-of-line
//   /* */ block comments (not nested)
//   $tag$ ... $tag$ PostgreSQL dollar-quoted strings (tag may be empty)
function splitStatements(sqlText) {
  const src = String(sqlText || '');
  const out = [];
  let buf = '';
  let i = 0;
  const len = src.length;
  let parenDepth = 0;
  while (i < len) {
    const c = src[i];
    const c2 = src[i + 1];

    // line comment
    if (c === '-' && c2 === '-') {
      while (i < len && src[i] !== '\n') { buf += src[i++]; }
      continue;
    }
    // block comment
    if (c === '/' && c2 === '*') {
      buf += c; buf += c2; i += 2;
      while (i < len && !(src[i] === '*' && src[i + 1] === '/')) { buf += src[i++]; }
      if (i < len) { buf += src[i++]; buf += src[i++]; }
      continue;
    }
    // single-quoted string
    if (c === "'") {
      buf += c; i++;
      while (i < len) {
        if (src[i] === "'" && src[i + 1] === "'") { buf += "''"; i += 2; continue; }
        if (src[i] === "'") { buf += "'"; i++; break; }
        buf += src[i++];
      }
      continue;
    }
    // double-quoted identifier
    if (c === '"') {
      buf += c; i++;
      while (i < len) {
        if (src[i] === '"' && src[i + 1] === '"') { buf += '""'; i += 2; continue; }
        if (src[i] === '"') { buf += '"'; i++; break; }
        buf += src[i++];
      }
      continue;
    }
    // bracket-quoted identifier (MSSQL)
    if (c === '[') {
      buf += c; i++;
      while (i < len) {
        if (src[i] === ']' && src[i + 1] === ']') { buf += ']]'; i += 2; continue; }
        if (src[i] === ']') { buf += ']'; i++; break; }
        buf += src[i++];
      }
      continue;
    }
    // dollar-quoted string (PostgreSQL): $tag$ ... $tag$
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
      if (m) {
        const open = m[0];
        buf += open; i += open.length;
        const close = open;
        const end = src.indexOf(close, i);
        if (end === -1) { buf += src.slice(i); i = len; continue; }
        buf += src.slice(i, end) + close;
        i = end + close.length;
        continue;
      }
    }
    if (c === '(') {
      parenDepth++;
      buf += c;
      i++;
      continue;
    }
    if (c === ')') {
      if (parenDepth > 0) parenDepth--;
      buf += c;
      i++;
      continue;
    }
    // top-level statement terminator
    if (c === ';' && parenDepth === 0) {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = '';
      i++;
      continue;
    }
    buf += src[i++];
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

// Tokenize just enough SQL to make a conservative read-only decision. Quoted
// content and comments are deliberately ignored: keywords inside them cannot
// execute as SQL. An incomplete quoted/commented region is invalid and causes
// the classifier to fail closed.
function readOnlyTokens(statement) {
  const src = String(statement || '');
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && c2 === '-') {
      i += 2;
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '[') {
      const close = c === '[' ? ']' : c;
      i++;
      let closed = false;
      while (i < src.length) {
        if (src[i] === close && src[i + 1] === close) { i += 2; continue; }
        if (src[i] === close) { i++; closed = true; break; }
        i++;
      }
      if (!closed) return null;
      continue;
    }
    if (c === '$') {
      const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
      if (dollar) {
        const marker = dollar[0];
        const end = src.indexOf(marker, i + marker.length);
        if (end === -1) return null;
        i = end + marker.length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i++;
      while (i < src.length && /[A-Za-z0-9_$#]/.test(src[i])) i++;
      tokens.push({ type: 'word', value: src.slice(start, i).toUpperCase() });
      continue;
    }
    tokens.push({ type: 'symbol', value: c });
    i++;
  }
  return tokens;
}

function cteMainStatement(tokens) {
  let i = 1;
  if (tokens[i]?.value === 'RECURSIVE') i++;
  while (i < tokens.length) {
    let asIndex = -1;
    for (let depth = 0; i < tokens.length; i++) {
      if (tokens[i].value === '(') depth++;
      else if (tokens[i].value === ')') depth--;
      else if (depth === 0 && tokens[i].value === 'AS') { asIndex = i; break; }
    }
    if (asIndex === -1) return null;
    i = asIndex + 1;
    if (tokens[i]?.value === 'NOT') i++;
    if (tokens[i]?.value === 'MATERIALIZED') i++;
    if (tokens[i]?.value !== '(') return null;
    let depth = 0;
    do {
      if (tokens[i].value === '(') depth++;
      if (tokens[i].value === ')') depth--;
      i++;
    } while (i < tokens.length && depth > 0);
    if (depth !== 0) return null;
    if (tokens[i]?.value === ',') { i++; continue; }
    return tokens[i]?.type === 'word' ? tokens[i].value : null;
  }
  return null;
}

// Returns null when lexical checks place a statement in an allowed read-oriented
// class. Malformed lexical structure, unknown classes, and recognized writes
// are rejected; this is not a full SQL grammar or semantic validator.
function readOnlyViolation(statement) {
  const tokens = readOnlyTokens(statement);
  if (!tokens || tokens.length === 0) return 'UNKNOWN';

  let depth = 0;
  for (const token of tokens) {
    if (token.value === '(') depth++;
    else if (token.value === ')') {
      depth--;
      if (depth < 0) return 'UNKNOWN';
    }
  }
  if (depth !== 0) return 'UNKNOWN';

  const writeWords = new Set([
    'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'DROP', 'CREATE', 'ALTER',
    'GRANT', 'REVOKE', 'DENY', 'REPLACE', 'CALL', 'EXEC', 'EXECUTE', 'COPY',
    'VACUUM', 'ANALYZE', 'REINDEX', 'REFRESH', 'CLUSTER', 'COMMENT', 'SET', 'USE',
    'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'LOCK', 'UNLOCK', 'DO',
    'DECLARE', 'PREPARE', 'DEALLOCATE', 'DISCARD', 'LISTEN', 'UNLISTEN', 'NOTIFY',
    'KILL', 'SHUTDOWN', 'BACKUP', 'RESTORE', 'DBCC', 'CHECKPOINT', 'LOAD', 'ATTACH',
    'DETACH', 'IMPORT', 'EXPORT',
  ]);
  for (const token of tokens) {
    if (token.type === 'word' && writeWords.has(token.value)) return token.value;
  }

  // SELECT ... INTO writes a new table but starts with SELECT, so it needs its
  // own check after the general write-keyword scan above.
  const selectIndex = tokens.findIndex(token => token.type === 'word' && token.value === 'SELECT');
  if (selectIndex !== -1 && tokens.slice(selectIndex + 1).some(token => token.type === 'word' && token.value === 'INTO')) {
    return 'SELECT INTO';
  }

  const first = tokens.find(token => token.type === 'word')?.value;
  if (first === 'SELECT') return null;
  if (first === 'WITH' && cteMainStatement(tokens) === 'SELECT') return null;

  // EXPLAIN is safe only when it ultimately wraps a SELECT. The earlier scan
  // catches EXPLAIN UPDATE/DELETE and any other write hidden by the wrapper.
  if (first === 'EXPLAIN' && selectIndex !== -1) return null;
  return first || 'UNKNOWN';
}

// Returns null when every statement passes the shared lexical statement-class
// gate, or the reason it is blocked. PostgreSQL read-only query routes add a
// database-enforced read-only transaction for semantic side effects.
function violatesReadOnly(query) {
  for (const statement of splitStatements(query)) {
    const violation = readOnlyViolation(statement);
    if (violation) return violation;
  }
  return null;
}

// ── Driver options ───────────────────────────────────────────────────────────
const MSSQL_TRUST_CERT = String(process.env.MSSQL_TRUST_SERVER_CERT ?? 'true').toLowerCase() !== 'false';
const MSSQL_ENCRYPT = String(process.env.MSSQL_ENCRYPT ?? 'false').toLowerCase() === 'true';

// Stable snapshot of the .env default connection, captured at startup. A
// session's config gets overwritten when its user switches profiles, so we keep
// the originals here to expose a "Default" profile everyone can see and switch
// back to — without the client ever needing the password.
const DEFAULTS = {
  ms: { server: process.env.MSSQL_SERVER || '', user: process.env.MSSQL_USER || '', password: process.env.MSSQL_PASSWORD || '', db: process.env.MSSQL_DEFAULT_DB || null },
  pg: { host: process.env.PG_HOST || '', port: parseInt(process.env.PG_PORT) || 5432, user: process.env.PG_USER || '', password: process.env.PG_PASSWORD || '', db: process.env.PG_DEFAULT_DB || null },
};

function mssqlConfigFor(server, user, password) {
  return {
    server, user, password: password || '',
    options: { trustServerCertificate: MSSQL_TRUST_CERT, encrypt: MSSQL_ENCRYPT },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: QUERY_TIMEOUT_MS,
  };
}

function pgConfigFor(host, port, user, password) {
  return {
    host, port: parseInt(port) || 5432, user, password: password || '',
    max: 5, idleTimeoutMillis: 30000, statement_timeout: QUERY_TIMEOUT_MS,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Per-browser sessions
//
// Every live connection — the fixed ms/pg/ms2/pg2 slots and the added panels
// alike — is a `conn` record owned by one browser session, addressed through
// `req.conns` (fixed slots) or `req.session.conns` (added panels).
//
// This state used to be module-global, which meant the whole server process
// shared one live connection per slot: the moment anyone switched server or
// profile, everyone else's panels switched under them, one person's read-only
// profile silenced another person's writes, and Cancel aborted whoever's query
// happened to be running. Keying it by a session cookie is what keeps two
// people out of each other's way.
//
// In-memory is enough because the process is single-instance by deployment
// (iisnode nodeProcessCountPerApplication="1", one Docker container). A restart
// drops every session; browsers re-establish from their saved profiles on load.
// ════════════════════════════════════════════════════════════════════════════
const SESSION_COOKIE = 'sqlmgmt_sid';
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS) || 8 * 60 * 60 * 1000;
const SESSION_SWEEP_MS = 5 * 60 * 1000;

const sessions = new Map();   // sid → session

function makeConn(id, type) {
  return {
    id, type,                 // type: 'mssql' | 'pg'
    readOnly: false,
    name: '',
    mssqlConfig: null,
    mssqlPools: new Map(),
    mssqlCurrentRequest: null,
    pgConfig: null,
    pgPool: null, pgPoolDb: null, pgPoolSwitch: null, pgCurrentPid: null,
  };
}

// Slot 1 starts preloaded with the .env default so a fresh browser can query
// straight away; slot 2 stays blank until its user configures it. This mirrors
// exactly how the old module-level configs were initialised.
function makeFixedSlots() {
  const ms = makeConn('ms', 'mssql');
  ms.mssqlConfig = mssqlConfigFor(
    process.env.MSSQL_SERVER || 'localhost',
    process.env.MSSQL_USER || 'sa',
    process.env.MSSQL_PASSWORD,
  );
  const pg = makeConn('pg', 'pg');
  pg.pgConfig = pgConfigFor(
    process.env.PG_HOST || 'localhost',
    process.env.PG_PORT,
    process.env.PG_USER || 'postgres',
    process.env.PG_PASSWORD,
  );
  return { ms, pg, ms2: makeConn('ms2', 'mssql'), pg2: makeConn('pg2', 'pg') };
}

function makeSession(id) {
  return { id, lastSeen: Date.now(), slots: makeFixedSlots(), conns: new Map() };
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  });
  return out;
}

function attachSession(req, res, next) {
  const presented = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  // A well-formed id we no longer know (server restarted, or the sweeper
  // reclaimed it) is adopted rather than replaced, so a browser keeps one
  // identity instead of accumulating orphaned cookies.
  const valid = /^[a-f0-9]{32}$/.test(presented || '') ? presented : null;
  const sid = valid || crypto.randomUUID().replace(/-/g, '');
  if (!sessions.has(sid)) sessions.set(sid, makeSession(sid));
  if (!valid) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const secure = req.secure || proto === 'https';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  }
  const session = sessions.get(sid);
  session.lastSeen = Date.now();
  req.session = session;
  req.conns = session.slots;
  next();
}

async function closeConn(conn) {
  for (const pool of conn.mssqlPools.values()) await pool.close().catch(() => {});
  conn.mssqlPools.clear();
  if (conn.pgPool) {
    await conn.pgPool.end().catch(() => {});
    conn.pgPool = null;
    conn.pgPoolDb = null;
  }
}

async function closeSession(session) {
  for (const conn of [...Object.values(session.slots), ...session.conns.values()]) {
    try { await closeConn(conn); } catch {}
  }
}

// Reclaim the pools of browsers that stopped calling. An open tab polls
// /api/status continuously, so only a closed one goes idle long enough to be
// swept. unref() keeps this timer from holding the process open.
const sessionSweeper = setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.lastSeen > cutoff) continue;
    sessions.delete(id);
    closeSession(session).catch(() => {});
  }
}, SESSION_SWEEP_MS);
sessionSweeper.unref?.();

// ── Pool access, always scoped to one conn record ────────────────────────────
async function connMssqlPool(conn, database = 'master') {
  if (!conn.mssqlConfig || !conn.mssqlConfig.server) {
    throw new Error(conn.id === 'ms2'
      ? 'SQL Server slot 2 not connected. Click ⚙ to configure.'
      : 'Connection not configured.');
  }
  if (!conn.mssqlPools.has(database)) {
    const pool = await new sql.ConnectionPool({ ...conn.mssqlConfig, database }).connect();
    conn.mssqlPools.set(database, pool);
  }
  return conn.mssqlPools.get(database);
}

async function connResetMssqlPools(conn) {
  for (const pool of conn.mssqlPools.values()) await pool.close().catch(() => {});
  conn.mssqlPools.clear();
}

async function connPgPool(conn, database) {
  if (!conn.pgConfig || !conn.pgConfig.host) {
    throw new Error(conn.id === 'pg2'
      ? 'PostgreSQL slot 2 not connected. Click ⚙ to configure.'
      : 'Connection not configured.');
  }
  if (conn.pgPool && conn.pgPoolDb === database) return conn.pgPool;
  // Serialize concurrent switches (e.g. parallel tables/views/procedures
  // fetches on a DB change) so we don't rebuild — and leak — the pool N times.
  if (conn.pgPoolSwitch) {
    await conn.pgPoolSwitch.catch(() => {});
    if (conn.pgPool && conn.pgPoolDb === database) return conn.pgPool;
  }
  conn.pgPoolSwitch = (async () => {
    if (conn.pgPool) await conn.pgPool.end().catch(() => {});
    conn.pgPool = new Pool({ ...conn.pgConfig, database });
    conn.pgPoolDb = database;
  })();
  try { await conn.pgPoolSwitch; } finally { conn.pgPoolSwitch = null; }
  return conn.pgPool;
}

async function connPgQuery(conn, database, queryText) {
  const pool = await connPgPool(conn, database);
  return pool.query(queryText);
}

// ── Primary-key lookup (used by the "edit cell → UPDATE" feature) ──────────────
const MSSQL_PK_SQL = `
  SELECT kcu.COLUMN_NAME AS col
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
  JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
    ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
   AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
   AND kcu.TABLE_NAME = tc.TABLE_NAME
  WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
    AND tc.TABLE_SCHEMA = @schema AND tc.TABLE_NAME = @table
  ORDER BY kcu.ORDINAL_POSITION`;

const PG_PK_SQL = `
  SELECT a.attname AS col, array_position(i.indkey::int[], a.attnum::int) AS pos
  FROM pg_index i
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
  WHERE i.indrelid = format('%I.%I', $1, $2)::regclass AND i.indisprimary
  ORDER BY pos`;

async function mssqlPkColumns(pool, schema, table) {
  const r = await pool.request().input('schema', schema).input('table', table).query(MSSQL_PK_SQL);
  return r.recordset.map(x => x.col);
}

async function pgPkColumns(getPool, db, schema, table) {
  const pool = await getPool(db);
  const r = await pool.query(PG_PK_SQL, [schema, table]);
  return r.rows.map(x => x.col);
}

// ── Foreign-key lookup (powers the 🔗 FK markers in the column browser) ────────
const MSSQL_FK_SQL = `
  SELECT cpa.name AS col, sr.name AS refSchema, tr.name AS refTable, cref.name AS refColumn
  FROM sys.foreign_key_columns fkc
  JOIN sys.tables  t   ON t.object_id  = fkc.parent_object_id
  JOIN sys.schemas s   ON s.schema_id  = t.schema_id
  JOIN sys.columns cpa ON cpa.object_id = fkc.parent_object_id AND cpa.column_id = fkc.parent_column_id
  JOIN sys.tables  tr  ON tr.object_id = fkc.referenced_object_id
  JOIN sys.schemas sr  ON sr.schema_id = tr.schema_id
  JOIN sys.columns cref ON cref.object_id = fkc.referenced_object_id AND cref.column_id = fkc.referenced_column_id
  WHERE s.name = @schema AND t.name = @table`;

const PG_FK_SQL = `
  SELECT kcu.column_name AS col,
         ccu.table_schema AS "refSchema", ccu.table_name AS "refTable", ccu.column_name AS "refColumn"
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`;

// Returns { colName: { refSchema, refTable, refColumn } }. Never throws — FK info
// is decorative, so a failure here must not break the columns list.
async function mssqlFkMap(pool, schema, table) {
  try {
    const r = await pool.request().input('schema', schema).input('table', table).query(MSSQL_FK_SQL);
    const m = {};
    for (const x of r.recordset) m[x.col] = { refSchema: x.refSchema, refTable: x.refTable, refColumn: x.refColumn };
    return m;
  } catch { return {}; }
}
async function pgFkMap(pool, schema, table) {
  try {
    const r = await pool.query(PG_FK_SQL, [schema, table]);
    const m = {};
    for (const x of r.rows) m[x.col] = { refSchema: x.refSchema, refTable: x.refTable, refColumn: x.refColumn };
    return m;
  } catch { return {}; }
}

// ── MSSQL estimated execution plan (SET SHOWPLAN_ALL) ──────────────────────────
// SHOWPLAN_ALL must be the only statement in its batch and is connection-scoped,
// so we pin one connection via a transaction, capture the plan (the query is NOT
// executed while SHOWPLAN is on), then turn it off and roll back. Returns the
// same { results, error } shape as /query so the UI can reuse its renderer.
async function mssqlEstimatedPlan(pool, query) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  let rows = [];
  try {
    const req = new sql.Request(tx);
    await req.batch('SET SHOWPLAN_ALL ON');
    const r = await req.batch(query);
    rows = r.recordset || [];
    await req.batch('SET SHOWPLAN_ALL OFF');
  } finally {
    try { await tx.rollback(); } catch {}
  }
  const columns = rows.length ? Object.keys(rows[0]) : ['StmtText'];
  return { results: [{ statement: query, columns, rows, rowsAffected: 0, durationMs: 0 }], error: null };
}

// ── Connection update routes ──────────────────────────────────────────────────
app.post('/api/mssql/connect', async (req, res) => {
  const { server, user, password, readOnly } = req.body;
  if (!server || !user) return res.status(400).json({ error: 'server and user required' });
  req.conns.ms.mssqlConfig = mssqlConfigFor(server, user, password || req.conns.ms.mssqlConfig?.password);
  req.conns.ms.readOnly = !!readOnly;
  await connResetMssqlPools(req.conns.ms);
  try {
    await connMssqlPool(req.conns.ms, 'master');
    res.json({ ok: true, server, user, readOnly: req.conns.ms.readOnly });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pg/connect', async (req, res) => {
  const { host, port, user, password, readOnly } = req.body;
  if (!host || !user) return res.status(400).json({ error: 'host and user required' });
  req.conns.pg.pgConfig = pgConfigFor(host, port, user, password || req.conns.pg.pgConfig?.password);
  req.conns.pg.readOnly = !!readOnly;
  if (req.conns.pg.pgPool) { await req.conns.pg.pgPool.end().catch(() => {}); req.conns.pg.pgPool = null; req.conns.pg.pgPoolDb = null; }
  try {
    // Force a real connection so the pool is actually live (and credential/host
    // errors surface here) before the client starts loading databases. new Pool()
    // is lazy, so without this the first /databases query races a cold connect.
    await connPgQuery(req.conns.pg, 'postgres', 'SELECT 1');
    res.json({ ok: true, host: req.conns.pg.pgConfig.host, port: req.conns.pg.pgConfig.port, user: req.conns.pg.pgConfig.user, readOnly: req.conns.pg.readOnly });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/status', async (req, res) => {
  const pgStats = req.conns.pg.pgPool ? {
    total: req.conns.pg.pgPool.totalCount,
    idle: req.conns.pg.pgPool.idleCount,
    waiting: req.conns.pg.pgPool.waitingCount,
    database: req.conns.pg.pgPoolDb,
  } : null;

  // Query pg_stat_activity for the real server-side client count
  let pgClients = null;
  if (req.conns.pg.pgPool && req.conns.pg.pgPoolDb) {
    try {
      const r = await req.conns.pg.pgPool.query(
        `SELECT count(*)::int AS n, json_agg(json_build_object(
           'pid',      pid,
           'db',       datname,
           'user',     usename,
           'app',      application_name,
           'type',     backend_type,
           'state',    state,
           'wait',     coalesce(wait_event_type || '/' || wait_event, null),
           'addr',     host(client_addr),
           'query',    left(query, 120),
           'duration', extract(epoch from (now() - state_change))::int
         ) ORDER BY state_change DESC) AS rows
         FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()`
      );
      pgClients = { count: r.rows[0].n, rows: r.rows[0].rows || [] };
      pgClients.rows.forEach(c => { if (c.addr) c.host = rdnsLookup(c.addr); });
    } catch {}
  }

  const msPools = {};
  for (const [db, pool] of req.conns.ms.mssqlPools.entries()) {
    try { msPools[db] = { size: pool.size, available: pool.available }; }
    catch { msPools[db] = {}; }
  }

  res.json({
    pg:  { host: req.conns.pg.pgConfig.host,  port: req.conns.pg.pgConfig.port,  user: req.conns.pg.pgConfig.user,  pool: pgStats, clients: pgClients, readOnly: req.conns.pg.readOnly, defaultDb: process.env.PG_DEFAULT_DB   || null },
    ms:  { server: req.conns.ms.mssqlConfig.server,  user: req.conns.ms.mssqlConfig.user,  pools: msPools, defaultDb: process.env.MSSQL_DEFAULT_DB || null },
    // Slot 2 stays unconfigured (config === null) until its user sets it up;
    // report the same empty-but-present shape the client has always seen.
    pg2: { host: req.conns.pg2.pgConfig?.host || '', port: req.conns.pg2.pgConfig?.port || 5432, user: req.conns.pg2.pgConfig?.user || '', connected: !!req.conns.pg2.pgConfig?.host },
    ms2: { server: req.conns.ms2.mssqlConfig?.server || '', user: req.conns.ms2.mssqlConfig?.user || '', connected: !!req.conns.ms2.mssqlConfig?.server },
    // .env default connection — rendered as a non-deletable "Default" profile.
    defaults: {
      ms: { server: DEFAULTS.ms.server, user: DEFAULTS.ms.user, db: DEFAULTS.ms.db, hasPassword: !!DEFAULTS.ms.password },
      pg: { host: DEFAULTS.pg.host, port: DEFAULTS.pg.port, user: DEFAULTS.pg.user, db: DEFAULTS.pg.db, hasPassword: !!DEFAULTS.pg.password },
    },
  });
});

// Reconnect the primary slot to the .env default (server-side password, never
// sent to the client). Powers the "Default" profile button.
app.post('/api/mssql/connect-default', async (req, res) => {
  if (!DEFAULTS.ms.server || !DEFAULTS.ms.user) return res.status(400).json({ error: 'No default SQL Server configured in .env' });
  req.conns.ms.mssqlConfig = mssqlConfigFor(DEFAULTS.ms.server, DEFAULTS.ms.user, DEFAULTS.ms.password);
  req.conns.ms.readOnly = false;
  await connResetMssqlPools(req.conns.ms);
  try {
    await connMssqlPool(req.conns.ms, 'master');
    res.json({ ok: true, server: DEFAULTS.ms.server, user: DEFAULTS.ms.user, readOnly: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pg/connect-default', async (req, res) => {
  if (!DEFAULTS.pg.host || !DEFAULTS.pg.user) return res.status(400).json({ error: 'No default PostgreSQL configured in .env' });
  req.conns.pg.pgConfig = pgConfigFor(DEFAULTS.pg.host, DEFAULTS.pg.port, DEFAULTS.pg.user, DEFAULTS.pg.password);
  req.conns.pg.readOnly = false;
  if (req.conns.pg.pgPool) { await req.conns.pg.pgPool.end().catch(() => {}); req.conns.pg.pgPool = null; req.conns.pg.pgPoolDb = null; }
  try {
    await connPgQuery(req.conns.pg, 'postgres', 'SELECT 1');
    res.json({ ok: true, host: DEFAULTS.pg.host, port: DEFAULTS.pg.port, user: DEFAULTS.pg.user, readOnly: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pg/disconnect', async (req, res) => {
  try {
    if (req.conns.pg.pgPool) { await req.conns.pg.pgPool.end().catch(() => {}); req.conns.pg.pgPool = null; req.conns.pg.pgPoolDb = null; }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Terminate server-side PG backends. Body: { pids: [int,...] } or { scope: 'idle' | 'all' }.
// Always excludes our own backend (pg_backend_pid()). Blocked on read-only profiles.
app.post('/api/pg/terminate', async (req, res) => {
  const ip = clientIp(req);
  const auditBase = { side: 'pg', host: req.conns.pg.pgConfig.host, user: req.conns.pg.pgConfig.user, readOnly: req.conns.pg.readOnly, db: req.conns.pg.pgPoolDb, clientIp: ip };
  if (req.conns.pg.readOnly) {
    auditLog({ ...auditBase, query: 'pg_terminate_backend', status: 'blocked', error: 'Read-only profile blocked terminate', durationMs: 0 });
    return res.status(403).json({ error: 'Read-only profile — terminating connections is blocked.' });
  }
  if (!req.conns.pg.pgPool) return res.status(400).json({ error: 'No active PostgreSQL pool.' });

  const { pids, scope } = req.body || {};
  try {
    let sql, params;
    if (Array.isArray(pids) && pids.length) {
      const clean = pids.map(Number).filter(n => Number.isInteger(n) && n > 0);
      if (!clean.length) return res.status(400).json({ error: 'No valid pids provided.' });
      sql = `SELECT pid, pg_terminate_backend(pid) AS terminated
             FROM pg_stat_activity
             WHERE pid = ANY($1::int[]) AND pid <> pg_backend_pid()
               AND backend_type = 'client backend'`;
      params = [clean];
    } else if (scope === 'idle' || scope === 'all') {
      sql = `SELECT pid, pg_terminate_backend(pid) AS terminated
             FROM pg_stat_activity
             WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'
               ${scope === 'idle' ? "AND state = 'idle'" : ''}`;
      params = [];
    } else {
      return res.status(400).json({ error: 'Provide pids[] or scope ("idle" | "all").' });
    }
    const r = await req.conns.pg.pgPool.query(sql, params);
    const killed = r.rows.filter(row => row.terminated).map(row => row.pid);
    auditLog({ ...auditBase, query: `pg_terminate_backend ${scope || 'pids'}`, status: 'ok', terminated: killed.length, pids: killed, durationMs: 0 });
    res.json({ ok: true, terminated: killed.length, pids: killed });
  } catch (e) {
    auditLog({ ...auditBase, query: 'pg_terminate_backend', status: 'error', error: e.message, durationMs: 0 });
    res.status(500).json({ error: e.message });
  }
});

// ── MSSQL routes ──────────────────────────────────────────────────────────────
app.get('/api/mssql/databases', async (req, res) => {
  try {
    const pool = await connMssqlPool(req.conns.ms, 'master');
    const r = await pool.request().query(`
      SELECT name FROM sys.databases
      WHERE state_desc = 'ONLINE' AND name NOT IN ('master','tempdb','model','msdb')
      ORDER BY name
    `);
    res.json(r.recordset.map(row => row.name));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/mssql/tables', async (req, res) => {
  const { db } = req.query;
  if (!db) return res.status(400).json({ error: 'db param required' });
  try {
    const pool = await connMssqlPool(req.conns.ms, db);
    const r = await pool.request().query(`
      SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS name
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_SCHEMA, TABLE_NAME
    `);
    res.json(r.recordset);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/mssql/views', async (req, res) => {
  const { db } = req.query;
  if (!db) return res.status(400).json({ error: 'db param required' });
  try {
    const pool = await connMssqlPool(req.conns.ms, db);
    const r = await pool.request().query(`
      SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS name
      FROM INFORMATION_SCHEMA.VIEWS
      ORDER BY TABLE_SCHEMA, TABLE_NAME
    `);
    res.json(r.recordset);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/mssql/procedures', async (req, res) => {
  const { db } = req.query;
  if (!db) return res.status(400).json({ error: 'db param required' });
  try {
    const pool = await connMssqlPool(req.conns.ms, db);
    const r = await pool.request().query(`
      SELECT
        r.ROUTINE_SCHEMA AS [schema],
        r.ROUTINE_NAME AS name,
        p.PARAMETER_NAME AS paramName,
        p.DATA_TYPE AS paramType,
        p.PARAMETER_MODE AS paramMode,
        p.ORDINAL_POSITION AS ordinal
      FROM INFORMATION_SCHEMA.ROUTINES r
      LEFT JOIN INFORMATION_SCHEMA.PARAMETERS p
        ON p.SPECIFIC_SCHEMA = r.SPECIFIC_SCHEMA
       AND p.SPECIFIC_NAME = r.SPECIFIC_NAME
      WHERE r.ROUTINE_TYPE = 'PROCEDURE'
      ORDER BY r.ROUTINE_SCHEMA, r.ROUTINE_NAME, p.ORDINAL_POSITION
    `);
    const map = new Map();
    for (const row of r.recordset) {
      const key = `${row.schema}.${row.name}`;
      if (!map.has(key)) map.set(key, { schema: row.schema, name: row.name, params: [] });
      if (row.paramName) {
        map.get(key).params.push({
          name: row.paramName.replace(/^@/, ''),
          type: row.paramType,
          mode: row.paramMode || 'IN',
        });
      }
    }
    res.json([...map.values()]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/mssql/pk', async (req, res) => {
  const { db, schema, table } = req.query;
  if (!db || !schema || !table) return res.status(400).json({ error: 'db, schema, table required' });
  try { res.json({ columns: await mssqlPkColumns(await connMssqlPool(req.conns.ms, db), schema, table) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});


app.post('/api/mssql/query', async (req, res) => {
  const { query, database } = req.body;
  const ip = clientIp(req);
  const auditBase = { side: 'ms', host: req.conns.ms.mssqlConfig.server, user: req.conns.ms.mssqlConfig.user, readOnly: req.conns.ms.readOnly, db: database, query, clientIp: ip };
  if (!database) {
    auditLog({ ...auditBase, status: 'error', error: 'database required', durationMs: 0, statementCount: 0 });
    return res.status(400).json({ error: 'database required' });
  }
  if (req.conns.ms.readOnly) {
    const v = violatesReadOnly(query);
    if (v) {
      auditLog({ ...auditBase, status: 'blocked', error: `Read-only blocked ${v}`, durationMs: 0, statementCount: 0 });
      return res.status(403).json({ error: `Read-only profile blocked ${v} statement.` });
    }
  }

  const statements = splitStatements(query);
  if (statements.length === 0) {
    return res.json({ results: [], error: null });
  }

  // Wrap every user statement so sp_executesql's "entry @@TRANCOUNT must equal
  // exit @@TRANCOUNT" check (Msg 266) is always satisfied — regardless of what
  // logon triggers, server-level hooks, or IMPLICIT_TRANSACTIONS quirks do to
  // the count during the body. We capture entry @@TRANCOUNT, run the user
  // statement, then commit-extras or open-fillers until we exit at the same
  // count we entered with.
  //   · IMPLICIT_TRANSACTIONS OFF — stops plain SELECT/etc. from auto-opening
  //     transactions where the server has implicit-tx on by default.
  //   · XACT_ABORT ON            — any error aborts cleanly without leaving a
  //     half-open transaction on the pooled connection for the next request.
  const PRE  = 'DECLARE @__tc INT = @@TRANCOUNT; SET IMPLICIT_TRANSACTIONS OFF; SET XACT_ABORT ON;\n';
  const POST = '\n;WHILE @@TRANCOUNT > @__tc COMMIT TRAN; WHILE @@TRANCOUNT < @__tc BEGIN TRAN;';

  const t0 = Date.now();
  const results = [];
  let request;
  try {
    const pool = await connMssqlPool(req.conns.ms, database);
    request = pool.request();
    req.conns.ms.mssqlCurrentRequest = request;
    // NB: no outer BEGIN TRAN/COMMIT TRAN wrap. The previous wrap was
    // unreliable because pool.request().query() can run each statement on a
    // different physical connection from the pool, so BEGIN/COMMIT didn't
    // actually bracket the user's statements atomically. If you need
    // multi-statement atomicity, write `BEGIN TRAN`/`COMMIT TRAN` explicitly
    // in the batch and run it as a single statement.
    for (const stmt of statements) {
      const sT = Date.now();
      const r = await request.query(PRE + stmt + POST);
      const rows = r.recordset || [];
      const columns = r.recordset?.columns
        ? Object.keys(r.recordset.columns)
        : (rows.length > 0 ? Object.keys(rows[0]) : []);
      // Sum rowsAffected across the wrapped batch: the PRE/POST helper
      // statements all report 0, so the total equals the user statement's
      // own affected-row count for INSERT/UPDATE/DELETE.
      const rowsAffected = Array.isArray(r.rowsAffected)
        ? r.rowsAffected.reduce((a, b) => a + (b || 0), 0)
        : (r.rowsAffected ?? rows.length);
      results.push({
        statement: stmt,
        columns,
        rows,
        rowsAffected,
        durationMs: Date.now() - sT,
      });
    }
    res.json({ results, error: null });
    auditLog({
      ...auditBase,
      status: 'ok',
      statementCount: statements.length,
      statementResults: results.map(r => ({ rows: r.rows.length, durationMs: r.durationMs })),
      rows: results.reduce((n, r) => n + r.rows.length, 0),
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    const cancelled = /canceled/i.test(e.message);
    const errPayload = {
      statementIndex: results.length,
      message: cancelled ? 'Query cancelled' : e.message,
      code: e.code || e.number || null,
      lineNumber: e.lineNumber || e.originalError?.info?.lineNumber || null,
    };
    if (cancelled) {
      res.status(499).json({ results, error: errPayload });
    } else {
      res.status(200).json({ results, error: errPayload });
    }
    auditLog({
      ...auditBase,
      status: cancelled ? 'cancelled' : 'error',
      error: e.message,
      code: e.code || e.number || null,
      statementCount: statements.length,
      failedAt: results.length,
      durationMs: Date.now() - t0,
    });
  } finally {
    if (req.conns.ms.mssqlCurrentRequest === request) req.conns.ms.mssqlCurrentRequest = null;
  }
});

app.post('/api/mssql/cancel', (req, res) => {
  if (!req.conns.ms.mssqlCurrentRequest) return res.json({ ok: false, reason: 'no active query' });
  try { req.conns.ms.mssqlCurrentRequest.cancel(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mssql/explain', async (req, res) => {
  const { query, database } = req.body;
  if (!database) return res.status(400).json({ error: 'database required' });
  if (!query || !query.trim()) return res.status(400).json({ error: 'query required' });
  try {
    const pool = await connMssqlPool(req.conns.ms, database);
    res.json(await mssqlEstimatedPlan(pool, query));
  } catch (e) {
    res.status(200).json({ results: [], error: { statementIndex: 0, message: e.message, code: e.number || null } });
  }
});

// ── PostgreSQL routes ─────────────────────────────────────────────────────────
app.get('/api/pg/databases', async (req, res) => {
  try {
    const r = await connPgQuery(req.conns.pg, 'postgres', `
      SELECT datname FROM pg_database
      WHERE datistemplate = false ORDER BY datname
    `);
    res.json(r.rows.map(row => row.datname));
  } catch (e) {
    console.error(`[pg/databases] ${req.conns.pg.pgConfig.user}@${req.conns.pg.pgConfig.host}:${req.conns.pg.pgConfig.port} →`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pg/tables', async (req, res) => {
  const { db } = req.query;
  if (!db) return res.status(400).json({ error: 'db param required' });
  try {
    const r = await connPgQuery(req.conns.pg, db, `
      SELECT table_schema AS schema, table_name AS name
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pg/views', async (req, res) => {
  const { db } = req.query;
  if (!db) return res.status(400).json({ error: 'db param required' });
  try {
    const r = await connPgQuery(req.conns.pg, db, `
      SELECT schemaname AS schema, viewname AS name
      FROM pg_views
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY schemaname, viewname
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function parsePgFunctionArgs(args) {
  if (!args || !args.trim()) return [];
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of args) {
    if (ch === '(' ) depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(raw => {
    const s = raw.trim();
    const modeMatch = s.match(/^(IN|OUT|INOUT|VARIADIC)\s+/i);
    let rest = modeMatch ? s.slice(modeMatch[0].length) : s;
    const mode = (modeMatch ? modeMatch[1] : 'IN').toUpperCase();
    rest = rest.replace(/\s+DEFAULT\s+.*$/i, '').trim();
    const space = rest.indexOf(' ');
    if (space === -1) return { name: '', type: rest, mode };
    return { name: rest.slice(0, space), type: rest.slice(space + 1).trim(), mode };
  });
}

app.get('/api/pg/procedures', async (req, res) => {
  const { db } = req.query;
  if (!db) return res.status(400).json({ error: 'db param required' });
  try {
    const r = await connPgQuery(req.conns.pg, db, `
      SELECT n.nspname AS schema,
             p.proname AS name,
             p.prokind AS prokind,
             pg_get_function_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prokind IN ('f', 'p')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY n.nspname, p.proname
    `);
    res.json(r.rows.map(row => {
      let params = [];
      try { params = parsePgFunctionArgs(row.args); } catch { params = []; }
      return {
        schema: row.schema,
        name: row.name,
        kind: row.prokind === 'p' ? 'PROCEDURE' : 'FUNCTION',
        params,
      };
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pg/pk', async (req, res) => {
  const { db, schema, table } = req.query;
  if (!db || !schema || !table) return res.status(400).json({ error: 'db, schema, table required' });
  try { res.json({ columns: await pgPkColumns(d => connPgPool(req.conns.pg, d), db, schema, table) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});


app.post('/api/pg/query', async (req, res) => {
  const { query, database } = req.body;
  const ip = clientIp(req);
  const auditBase = { side: 'pg', host: req.conns.pg.pgConfig.host, user: req.conns.pg.pgConfig.user, readOnly: req.conns.pg.readOnly, db: database, query, clientIp: ip };
  if (!database) {
    auditLog({ ...auditBase, status: 'error', error: 'database required', durationMs: 0, statementCount: 0 });
    return res.status(400).json({ error: 'database required' });
  }
  if (req.conns.pg.readOnly) {
    const v = violatesReadOnly(query);
    if (v) {
      auditLog({ ...auditBase, status: 'blocked', error: `Read-only blocked ${v}`, durationMs: 0, statementCount: 0 });
      return res.status(403).json({ error: `Read-only profile blocked ${v} statement.` });
    }
  }

  const statements = splitStatements(query);
  if (statements.length === 0) {
    return res.json({ results: [], error: null });
  }

  const t0 = Date.now();
  const results = [];
  let client;
  let txOpen = false;
  try {
    const pool = await connPgPool(req.conns.pg, database);
    client = await pool.connect();
    req.conns.pg.pgCurrentPid = client.processID;
    await client.query(req.conns.pg.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    txOpen = true;
    for (const stmt of statements) {
      const sT = Date.now();
      const r = await client.query(stmt);
      const columns = r.fields ? r.fields.map(f => f.name) : [];
      results.push({
        statement: stmt,
        columns,
        rows: r.rows || [],
        rowsAffected: r.rowCount ?? 0,
        durationMs: Date.now() - sT,
      });
    }
    await client.query('COMMIT');
    txOpen = false;
    res.json({ results, error: null });
    auditLog({
      ...auditBase,
      status: 'ok',
      statementCount: statements.length,
      statementResults: results.map(r => ({ rows: r.rows.length, durationMs: r.durationMs })),
      rows: results.reduce((n, r) => n + r.rows.length, 0),
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    const cancelled = /canceling statement due to user request/i.test(e.message);
    if (txOpen && client) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    const errPayload = {
      statementIndex: results.length,
      message: cancelled ? 'Query cancelled' : e.message,
      code: e.code || null,
      position: e.position ? parseInt(e.position) : null,
      hint: e.hint || null,
    };
    if (cancelled) {
      res.status(499).json({ results, error: errPayload });
    } else {
      res.status(200).json({ results, error: errPayload });
    }
    auditLog({
      ...auditBase,
      status: cancelled ? 'cancelled' : 'error',
      error: e.message,
      code: e.code || null,
      statementCount: statements.length,
      failedAt: results.length,
      durationMs: Date.now() - t0,
    });
  } finally {
    req.conns.pg.pgCurrentPid = null;
    if (client) client.release();
  }
});

app.post('/api/pg/cancel', async (req, res) => {
  if (!req.conns.pg.pgCurrentPid) return res.json({ ok: false, reason: 'no active query' });
  const pid = parseInt(req.conns.pg.pgCurrentPid);
  try {
    await connPgQuery(req.conns.pg, req.conns.pg.pgPoolDb || 'postgres', `SELECT pg_cancel_backend(${pid})`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Lightweight health probes (SELECT 1) ─────────────────────────────────────
app.get('/api/mssql/ping', async (req, res) => {
  const t0 = Date.now();
  try {
    const pool = await connMssqlPool(req.conns.ms, 'master');
    await pool.request().query('SELECT 1 AS ok');
    res.json({ ok: true, latencyMs: Date.now() - t0 });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message, latencyMs: Date.now() - t0 });
  }
});

app.get('/api/pg/ping', async (req, res) => {
  const t0 = Date.now();
  try {
    await connPgQuery(req.conns.pg, req.conns.pg.pgPoolDb || 'postgres', 'SELECT 1 AS ok');
    res.json({ ok: true, latencyMs: Date.now() - t0 });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message, latencyMs: Date.now() - t0 });
  }
});

function formatMssqlType(dataType, maxLen, numPrec, numScale) {
  const t = (dataType || '').toLowerCase();
  if (['varchar','nvarchar','char','nchar','varbinary','binary'].includes(t))
    return maxLen === -1 ? `${t}(max)` : maxLen ? `${t}(${maxLen})` : t;
  if (['decimal','numeric'].includes(t) && numPrec != null)
    return `${t}(${numPrec},${numScale ?? 0})`;
  return t;
}

app.get('/api/mssql/columns', async (req, res) => {
  const { db, schema, table } = req.query;
  if (!db || !table) return res.status(400).json({ error: 'db and table required' });
  try {
    const pool = await connMssqlPool(req.conns.ms, db);
    const r = await pool.request()
      .input('schema', sql.NVarChar, schema || 'dbo')
      .input('table', sql.NVarChar, table)
      .query(`SELECT COLUMN_NAME, DATA_TYPE,
                CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE,
                COLUMNPROPERTY(OBJECT_ID(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME)), COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY,
                COLUMNPROPERTY(OBJECT_ID(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME)), COLUMN_NAME, 'IsComputed') AS IS_COMPUTED
              FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
              ORDER BY ORDINAL_POSITION`);
    const fks = await mssqlFkMap(pool, schema || 'dbo', table);
    res.json(r.recordset.map(row => ({
      name: row.COLUMN_NAME,
      type: formatMssqlType(row.DATA_TYPE, row.CHARACTER_MAXIMUM_LENGTH, row.NUMERIC_PRECISION, row.NUMERIC_SCALE),
      identity: row.IS_IDENTITY === 1 || row.IS_COMPUTED === 1,
      fk: fks[row.COLUMN_NAME] || null,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function abbrevPgType(t) {
  return (t || '')
    .replace('character varying', 'varchar').replace('timestamp without time zone', 'timestamp')
    .replace('timestamp with time zone', 'timestamptz').replace('double precision', 'float8')
    .replace('character', 'char').replace('boolean', 'bool');
}

function formatPgType(dataType, charMaxLen, numPrec, numScale, dtPrec) {
  const t = abbrevPgType(dataType);
  if (charMaxLen) return `${t}(${charMaxLen})`;
  if (numPrec != null && (t === 'numeric' || t === 'decimal'))
    return numScale != null ? `${t}(${numPrec},${numScale})` : `${t}(${numPrec})`;
  if (dtPrec != null && (t === 'timestamp' || t === 'timestamptz' || t === 'time'))
    return dtPrec !== 6 ? `${t}(${dtPrec})` : t;
  return t;
}

app.get('/api/pg/columns', async (req, res) => {
  const { db, schema, table } = req.query;
  if (!db || !table) return res.status(400).json({ error: 'db and table required' });
  try {
    const r = await connPgQuery(req.conns.pg, db, {
      text: `SELECT column_name, data_type,
               character_maximum_length, numeric_precision, numeric_scale,
               datetime_precision, is_identity, is_generated, column_default
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position`,
      values: [schema || 'public', table],
    });
    const pool = await connPgPool(req.conns.pg, db);
    const fks = await pgFkMap(pool, schema || 'public', table);
    res.json(r.rows.map(row => ({
      name: row.column_name,
      type: formatPgType(row.data_type, row.character_maximum_length,
                         row.numeric_precision, row.numeric_scale, row.datetime_precision),
      identity: row.is_identity === 'YES'
        || row.is_generated === 'ALWAYS'
        || /^nextval\(/i.test(row.column_default || ''),
      fk: fks[row.column_name] || null,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Slot 2 (independent secondary connection, per session) ───────────────────
// State lives on req.conns.ms2 / req.conns.pg2; both start unconfigured, so
// connMssqlPool/connPgPool raise the "not connected, click ⚙" error until the
// user configures the slot.

// ── MSSQL Slot 2 routes ───────────────────────────────────────────────────────
app.post('/api/mssql2/connect', async (req, res) => {
  const { server, user, password, readOnly } = req.body;
  if (!server || !user) return res.status(400).json({ error: 'server and user required' });
  req.conns.ms2.mssqlConfig = mssqlConfigFor(server, user, password || req.conns.ms2.mssqlConfig?.password);
  req.conns.ms2.readOnly = !!readOnly;
  await connResetMssqlPools(req.conns.ms2);
  try {
    await connMssqlPool(req.conns.ms2, 'master');
    res.json({ ok: true, server, user, readOnly: req.conns.ms2.readOnly });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mssql2/databases', async (req, res) => {
  try {
    const pool = await connMssqlPool(req.conns.ms2, 'master');
    const r = await pool.request().query(`
      SELECT name FROM sys.databases
      WHERE state_desc = 'ONLINE' AND name NOT IN ('master','tempdb','model','msdb')
      ORDER BY name
    `);
    res.json(r.recordset.map(row => row.name));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mssql2/tables', async (req, res) => {
  const { db } = req.query;
  if (!db) return res.status(400).json({ error: 'db param required' });
  try {
    const pool = await connMssqlPool(req.conns.ms2, db);
    const r = await pool.request().query(`
      SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS name
      FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_SCHEMA, TABLE_NAME
    `);
    res.json(r.recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mssql2/views', async (req, res) => {
  const { db } = req.query;
  if (!db) return res.status(400).json({ error: 'db param required' });
  try {
    const pool = await connMssqlPool(req.conns.ms2, db);
    const r = await pool.request().query(`
      SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS name
      FROM INFORMATION_SCHEMA.VIEWS ORDER BY TABLE_SCHEMA, TABLE_NAME
    `);
    res.json(r.recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mssql2/procedures', async (req, res) => {
  const { db } = req.query;
  if (!db) return res.status(400).json({ error: 'db param required' });
  try {
    const pool = await connMssqlPool(req.conns.ms2, db);
    const r = await pool.request().query(`
      SELECT r.ROUTINE_SCHEMA AS [schema], r.ROUTINE_NAME AS name,
             p.PARAMETER_NAME AS paramName, p.DATA_TYPE AS paramType,
             p.PARAMETER_MODE AS paramMode, p.ORDINAL_POSITION AS ordinal
      FROM INFORMATION_SCHEMA.ROUTINES r
      LEFT JOIN INFORMATION_SCHEMA.PARAMETERS p
        ON p.SPECIFIC_SCHEMA = r.SPECIFIC_SCHEMA AND p.SPECIFIC_NAME = r.SPECIFIC_NAME
      WHERE r.ROUTINE_TYPE = 'PROCEDURE'
      ORDER BY r.ROUTINE_SCHEMA, r.ROUTINE_NAME, p.ORDINAL_POSITION
    `);
    const map = new Map();
    for (const row of r.recordset) {
      const key = `${row.schema}.${row.name}`;
      if (!map.has(key)) map.set(key, { schema: row.schema, name: row.name, params: [] });
      if (row.paramName) map.get(key).params.push({ name: row.paramName.replace(/^@/, ''), type: row.paramType, mode: row.paramMode || 'IN' });
    }
    res.json([...map.values()]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mssql2/pk', async (req, res) => {
  const { db, schema, table } = req.query;
  if (!db || !schema || !table) return res.status(400).json({ error: 'db, schema, table required' });
  try { res.json({ columns: await mssqlPkColumns(await connMssqlPool(req.conns.ms2, db), schema, table) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mssql2/query', async (req, res) => {
  const { query, database } = req.body;
  const ip = clientIp(req);
  const auditBase = { side: 'ms2', host: req.conns.ms2.mssqlConfig?.server || null, user: req.conns.ms2.mssqlConfig?.user || null, readOnly: req.conns.ms2.readOnly, db: database, query, clientIp: ip };
  if (!database) { auditLog({ ...auditBase, status: 'error', error: 'database required', durationMs: 0, statementCount: 0 }); return res.status(400).json({ error: 'database required' }); }
  if (req.conns.ms2.readOnly) { const v = violatesReadOnly(query); if (v) { auditLog({ ...auditBase, status: 'blocked', error: `Read-only blocked ${v}`, durationMs: 0, statementCount: 0 }); return res.status(403).json({ error: `Read-only profile blocked ${v} statement.` }); } }
  const statements = splitStatements(query);
  if (statements.length === 0) return res.json({ results: [], error: null });
  const PRE  = 'DECLARE @__tc INT = @@TRANCOUNT; SET IMPLICIT_TRANSACTIONS OFF; SET XACT_ABORT ON;\n';
  const POST = '\n;WHILE @@TRANCOUNT > @__tc COMMIT TRAN; WHILE @@TRANCOUNT < @__tc BEGIN TRAN;';
  const t0 = Date.now(); const results = []; let request;
  try {
    const pool = await connMssqlPool(req.conns.ms2, database);
    request = pool.request(); req.conns.ms2.mssqlCurrentRequest = request;
    for (const stmt of statements) {
      const sT = Date.now();
      const r = await request.query(PRE + stmt + POST);
      const rows = r.recordset || [];
      const columns = r.recordset?.columns ? Object.keys(r.recordset.columns) : (rows.length > 0 ? Object.keys(rows[0]) : []);
      const rowsAffected = Array.isArray(r.rowsAffected) ? r.rowsAffected.reduce((a, b) => a + (b || 0), 0) : (r.rowsAffected ?? rows.length);
      results.push({ statement: stmt, columns, rows, rowsAffected, durationMs: Date.now() - sT });
    }
    res.json({ results, error: null });
    auditLog({ ...auditBase, status: 'ok', statementCount: statements.length, statementResults: results.map(r => ({ rows: r.rows.length, durationMs: r.durationMs })), rows: results.reduce((n, r) => n + r.rows.length, 0), durationMs: Date.now() - t0 });
  } catch (e) {
    const cancelled = /canceled/i.test(e.message);
    const errPayload = { statementIndex: results.length, message: cancelled ? 'Query cancelled' : e.message, code: e.code || e.number || null, lineNumber: e.lineNumber || e.originalError?.info?.lineNumber || null };
    cancelled ? res.status(499).json({ results, error: errPayload }) : res.status(200).json({ results, error: errPayload });
    auditLog({ ...auditBase, status: cancelled ? 'cancelled' : 'error', error: e.message, code: e.code || e.number || null, statementCount: statements.length, failedAt: results.length, durationMs: Date.now() - t0 });
  } finally { if (req.conns.ms2.mssqlCurrentRequest === request) req.conns.ms2.mssqlCurrentRequest = null; }
});

app.post('/api/mssql2/explain', async (req, res) => {
  const { query, database } = req.body;
  if (!database) return res.status(400).json({ error: 'database required' });
  if (!query || !query.trim()) return res.status(400).json({ error: 'query required' });
  try {
    const pool = await connMssqlPool(req.conns.ms2, database);
    res.json(await mssqlEstimatedPlan(pool, query));
  } catch (e) {
    res.status(200).json({ results: [], error: { statementIndex: 0, message: e.message, code: e.number || null } });
  }
});

app.post('/api/mssql2/cancel', (req, res) => {
  if (!req.conns.ms2.mssqlCurrentRequest) return res.json({ ok: false, reason: 'no active query' });
  try { req.conns.ms2.mssqlCurrentRequest.cancel(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mssql2/ping', async (req, res) => {
  const t0 = Date.now();
  try { const pool = await connMssqlPool(req.conns.ms2, 'master'); await pool.request().query('SELECT 1 AS ok'); res.json({ ok: true, latencyMs: Date.now() - t0 }); }
  catch (e) { res.status(503).json({ ok: false, error: e.message, latencyMs: Date.now() - t0 }); }
});

app.get('/api/mssql2/columns', async (req, res) => {
  const { db, schema, table } = req.query;
  if (!db || !table) return res.status(400).json({ error: 'db and table required' });
  try {
    const pool = await connMssqlPool(req.conns.ms2, db);
    const r = await pool.request().input('schema', sql.NVarChar, schema || 'dbo').input('table', sql.NVarChar, table)
      .query(`SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE,
                COLUMNPROPERTY(OBJECT_ID(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME)), COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY,
                COLUMNPROPERTY(OBJECT_ID(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME)), COLUMN_NAME, 'IsComputed') AS IS_COMPUTED
              FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table ORDER BY ORDINAL_POSITION`);
    res.json(r.recordset.map(row => ({ name: row.COLUMN_NAME, type: formatMssqlType(row.DATA_TYPE, row.CHARACTER_MAXIMUM_LENGTH, row.NUMERIC_PRECISION, row.NUMERIC_SCALE), identity: row.IS_IDENTITY === 1 || row.IS_COMPUTED === 1 })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PG Slot 2 routes ──────────────────────────────────────────────────────────
app.post('/api/pg2/connect', async (req, res) => {
  const { host, port, user, password, readOnly } = req.body;
  if (!host || !user) return res.status(400).json({ error: 'host and user required' });
  req.conns.pg2.pgConfig = pgConfigFor(host, port, user, password || req.conns.pg2.pgConfig?.password);
  req.conns.pg2.readOnly = !!readOnly;
  if (req.conns.pg2.pgPool) { await req.conns.pg2.pgPool.end().catch(() => {}); req.conns.pg2.pgPool = null; req.conns.pg2.pgPoolDb = null; }
  try { await connPgQuery(req.conns.pg2, 'postgres', 'SELECT 1'); res.json({ ok: true, host: req.conns.pg2.pgConfig.host, port: req.conns.pg2.pgConfig.port, user: req.conns.pg2.pgConfig.user, readOnly: req.conns.pg2.readOnly }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pg2/disconnect', async (req, res) => {
  try { if (req.conns.pg2.pgPool) { await req.conns.pg2.pgPool.end().catch(() => {}); req.conns.pg2.pgPool = null; req.conns.pg2.pgPoolDb = null; } res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pg2/databases', async (req, res) => {
  try { const r = await connPgQuery(req.conns.pg2, 'postgres', 'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname'); res.json(r.rows.map(row => row.datname)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pg2/tables', async (req, res) => {
  const { db } = req.query;
  if (!db) return res.status(400).json({ error: 'db param required' });
  try { const r = await connPgQuery(req.conns.pg2, db, `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name`); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pg2/views', async (req, res) => {
  const { db } = req.query;
  if (!db) return res.status(400).json({ error: 'db param required' });
  try { const r = await connPgQuery(req.conns.pg2, db, `SELECT schemaname AS schema, viewname AS name FROM pg_views WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, viewname`); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pg2/procedures', async (req, res) => {
  const { db } = req.query;
  if (!db) return res.status(400).json({ error: 'db param required' });
  try {
    const r = await connPgQuery(req.conns.pg2, db, `SELECT n.nspname AS schema, p.proname AS name, p.prokind AS prokind, pg_get_function_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.prokind IN ('f', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY n.nspname, p.proname`);
    res.json(r.rows.map(row => { let params = []; try { params = parsePgFunctionArgs(row.args); } catch {} return { schema: row.schema, name: row.name, kind: row.prokind === 'p' ? 'PROCEDURE' : 'FUNCTION', params }; }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pg2/pk', async (req, res) => {
  const { db, schema, table } = req.query;
  if (!db || !schema || !table) return res.status(400).json({ error: 'db, schema, table required' });
  try { res.json({ columns: await pgPkColumns(d => connPgPool(req.conns.pg2, d), db, schema, table) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pg2/query', async (req, res) => {
  const { query, database } = req.body;
  const ip = clientIp(req);
  const auditBase = { side: 'pg2', host: req.conns.pg2.pgConfig?.host || null, user: req.conns.pg2.pgConfig?.user || null, readOnly: req.conns.pg2.readOnly, db: database, query, clientIp: ip };
  if (!database) { auditLog({ ...auditBase, status: 'error', error: 'database required', durationMs: 0, statementCount: 0 }); return res.status(400).json({ error: 'database required' }); }
  if (req.conns.pg2.readOnly) { const v = violatesReadOnly(query); if (v) { auditLog({ ...auditBase, status: 'blocked', error: `Read-only blocked ${v}`, durationMs: 0, statementCount: 0 }); return res.status(403).json({ error: `Read-only profile blocked ${v} statement.` }); } }
  const statements = splitStatements(query);
  if (statements.length === 0) return res.json({ results: [], error: null });
  const t0 = Date.now(); const results = []; let client; let txOpen = false;
  try {
    const pool = await connPgPool(req.conns.pg2, database);
    client = await pool.connect(); req.conns.pg2.pgCurrentPid = client.processID;
    await client.query(req.conns.pg2.readOnly ? 'BEGIN READ ONLY' : 'BEGIN'); txOpen = true;
    for (const stmt of statements) {
      const sT = Date.now(); const r = await client.query(stmt);
      const columns = r.fields ? r.fields.map(f => f.name) : [];
      results.push({ statement: stmt, columns, rows: r.rows || [], rowsAffected: r.rowCount ?? 0, durationMs: Date.now() - sT });
    }
    await client.query('COMMIT'); txOpen = false;
    res.json({ results, error: null });
    auditLog({ ...auditBase, status: 'ok', statementCount: statements.length, statementResults: results.map(r => ({ rows: r.rows.length, durationMs: r.durationMs })), rows: results.reduce((n, r) => n + r.rows.length, 0), durationMs: Date.now() - t0 });
  } catch (e) {
    const cancelled = /canceling statement due to user request/i.test(e.message);
    if (txOpen && client) { try { await client.query('ROLLBACK'); } catch {} }
    const errPayload = { statementIndex: results.length, message: cancelled ? 'Query cancelled' : e.message, code: e.code || null, position: e.position ? parseInt(e.position) : null, hint: e.hint || null };
    cancelled ? res.status(499).json({ results, error: errPayload }) : res.status(200).json({ results, error: errPayload });
    auditLog({ ...auditBase, status: cancelled ? 'cancelled' : 'error', error: e.message, code: e.code || null, statementCount: statements.length, failedAt: results.length, durationMs: Date.now() - t0 });
  } finally { req.conns.pg2.pgCurrentPid = null; if (client) client.release(); }
});

app.post('/api/pg2/cancel', async (req, res) => {
  if (!req.conns.pg2.pgCurrentPid) return res.json({ ok: false, reason: 'no active query' });
  const pid = parseInt(req.conns.pg2.pgCurrentPid);
  try { await connPgQuery(req.conns.pg2, req.conns.pg2.pgPoolDb || 'postgres', `SELECT pg_cancel_backend(${pid})`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pg2/ping', async (req, res) => {
  const t0 = Date.now();
  try { await connPgQuery(req.conns.pg2, req.conns.pg2.pgPoolDb || 'postgres', 'SELECT 1 AS ok'); res.json({ ok: true, latencyMs: Date.now() - t0 }); }
  catch (e) { res.status(503).json({ ok: false, error: e.message, latencyMs: Date.now() - t0 }); }
});

app.get('/api/pg2/columns', async (req, res) => {
  const { db, schema, table } = req.query;
  if (!db || !table) return res.status(400).json({ error: 'db and table required' });
  try {
    const r = await connPgQuery(req.conns.pg2, db, { text: `SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, datetime_precision, is_identity, is_generated, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, values: [schema || 'public', table] });
    res.json(r.rows.map(row => ({ name: row.column_name, type: formatPgType(row.data_type, row.character_maximum_length, row.numeric_precision, row.numeric_scale, row.datetime_precision), identity: row.is_identity === 'YES' || row.is_generated === 'ALWAYS' || /^nextval\(/i.test(row.column_default || '') })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Slot-2 reconnect-to-default (mirrors the slot-1 connect-default routes) so the
// "Default" button works when a panel is backed by the secondary slot.
app.post('/api/mssql2/connect-default', async (req, res) => {
  if (!DEFAULTS.ms.server || !DEFAULTS.ms.user) return res.status(400).json({ error: 'No default SQL Server configured in .env' });
  req.conns.ms2.mssqlConfig = mssqlConfigFor(DEFAULTS.ms.server, DEFAULTS.ms.user, DEFAULTS.ms.password);
  req.conns.ms2.readOnly = false;
  await connResetMssqlPools(req.conns.ms2);
  try { await connMssqlPool(req.conns.ms2, 'master'); res.json({ ok: true, server: DEFAULTS.ms.server, user: DEFAULTS.ms.user, readOnly: false }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pg2/connect-default', async (req, res) => {
  if (!DEFAULTS.pg.host || !DEFAULTS.pg.user) return res.status(400).json({ error: 'No default PostgreSQL configured in .env' });
  req.conns.pg2.pgConfig = pgConfigFor(DEFAULTS.pg.host, DEFAULTS.pg.port, DEFAULTS.pg.user, DEFAULTS.pg.password);
  req.conns.pg2.readOnly = false;
  if (req.conns.pg2.pgPool) { await req.conns.pg2.pgPool.end().catch(() => {}); req.conns.pg2.pgPool = null; req.conns.pg2.pgPoolDb = null; }
  try { await connPgQuery(req.conns.pg2, 'postgres', 'SELECT 1'); res.json({ ok: true, host: DEFAULTS.pg.host, port: DEFAULTS.pg.port, user: DEFAULTS.pg.user, readOnly: false }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/version', (req, res) => res.json({ version: pkg.version, build: '2026-06-23', features: ['conn-registry','default-profile','slot-aware-switch','toast-fix','no-api-cache'] }));

// ════════════════════════════════════════════════════════════════════════════
// Generic connection registry — UNLIMITED live connections, keyed by an opaque
// id within the calling browser's session. Each conn owns its own pool(s).
// Routes live under /api/conn/:id/...
//
// The ids are session-scoped, not global: two browsers both number their first
// added panel "c1", and each must get its own connection rather than the other
// person's. Session scoping is also what reclaims these when a browser goes
// away — a global map grew an orphan entry on every page reload.
//
// The legacy /api/{mssql,pg,mssql2,pg2}/... routes above are kept for
// back-compat but the dynamic-panel frontend uses only this generic layer.
// ════════════════════════════════════════════════════════════════════════════
function getConnOr404(req, res) {
  const conn = req.session.conns.get(req.params.id);
  if (!conn) { res.status(404).json({ error: `Unknown connection '${req.params.id}'. Connect first.` }); return null; }
  return conn;
}

app.get('/api/conn/list', (req, res) => {
  res.json([...req.session.conns.values()].map(c => ({
    id: c.id, type: c.type, name: c.name, readOnly: c.readOnly,
    server: c.mssqlConfig?.server || null,
    host: c.pgConfig?.host || null, port: c.pgConfig?.port || null,
    user: c.mssqlConfig?.user || c.pgConfig?.user || null,
    db: c.pgPoolDb || null,
  })));
});

app.post('/api/conn/:id/connect', async (req, res) => {
  const id = req.params.id;
  const { type, name, readOnly, server, user, password, host, port } = req.body;
  let conn = req.session.conns.get(id);
  const effType = type || conn?.type;
  if (!effType) return res.status(400).json({ error: 'type (mssql|pg) required' });
  if (!conn || conn.type !== effType) conn = makeConn(id, effType);
  conn.readOnly = !!readOnly;
  if (name != null) conn.name = name;
  req.session.conns.set(id, conn);
  try {
    if (conn.type === 'mssql') {
      if (!server || !user) return res.status(400).json({ error: 'server and user required' });
      conn.mssqlConfig = {
        server, user, password: password || conn.mssqlConfig?.password || '',
        options: { trustServerCertificate: MSSQL_TRUST_CERT, encrypt: MSSQL_ENCRYPT },
        pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
        requestTimeout: QUERY_TIMEOUT_MS,
      };
      await connResetMssqlPools(conn);
      await connMssqlPool(conn, 'master');
      res.json({ ok: true, id, type: 'mssql', server, user, readOnly: conn.readOnly });
    } else {
      if (!host || !user) return res.status(400).json({ error: 'host and user required' });
      conn.pgConfig = {
        host, port: parseInt(port) || 5432, user,
        password: password || conn.pgConfig?.password || '',
        max: 5, idleTimeoutMillis: 30000, statement_timeout: QUERY_TIMEOUT_MS,
      };
      if (conn.pgPool) { await conn.pgPool.end().catch(() => {}); conn.pgPool = null; conn.pgPoolDb = null; }
      await connPgQuery(conn, 'postgres', 'SELECT 1');
      res.json({ ok: true, id, type: 'pg', host: conn.pgConfig.host, port: conn.pgConfig.port, user, readOnly: conn.readOnly });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/conn/:id/disconnect', async (req, res) => {
  const conn = req.session.conns.get(req.params.id);
  if (!conn) return res.json({ ok: true });
  try {
    await connResetMssqlPools(conn);
    if (conn.pgPool) { await conn.pgPool.end().catch(() => {}); conn.pgPool = null; conn.pgPoolDb = null; }
    req.session.conns.delete(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/conn/:id/databases', async (req, res) => {
  const conn = getConnOr404(req, res); if (!conn) return;
  try {
    if (conn.type === 'mssql') {
      const pool = await connMssqlPool(conn, 'master');
      const r = await pool.request().query(`SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' AND name NOT IN ('master','tempdb','model','msdb') ORDER BY name`);
      res.json(r.recordset.map(row => row.name));
    } else {
      const r = await connPgQuery(conn, 'postgres', `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`);
      res.json(r.rows.map(row => row.datname));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/conn/:id/tables', async (req, res) => {
  const conn = getConnOr404(req, res); if (!conn) return;
  const { db } = req.query;
  if (!db) return res.status(400).json({ error: 'db param required' });
  try {
    if (conn.type === 'mssql') {
      const pool = await connMssqlPool(conn, db);
      const r = await pool.request().query(`SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME`);
      res.json(r.recordset);
    } else {
      const r = await connPgQuery(conn, db, `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name`);
      res.json(r.rows);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/conn/:id/views', async (req, res) => {
  const conn = getConnOr404(req, res); if (!conn) return;
  const { db } = req.query;
  if (!db) return res.status(400).json({ error: 'db param required' });
  try {
    if (conn.type === 'mssql') {
      const pool = await connMssqlPool(conn, db);
      const r = await pool.request().query(`SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS name FROM INFORMATION_SCHEMA.VIEWS ORDER BY TABLE_SCHEMA, TABLE_NAME`);
      res.json(r.recordset);
    } else {
      const r = await connPgQuery(conn, db, `SELECT schemaname AS schema, viewname AS name FROM pg_views WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, viewname`);
      res.json(r.rows);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/conn/:id/procedures', async (req, res) => {
  const conn = getConnOr404(req, res); if (!conn) return;
  const { db } = req.query;
  if (!db) return res.status(400).json({ error: 'db param required' });
  try {
    if (conn.type === 'mssql') {
      const pool = await connMssqlPool(conn, db);
      const r = await pool.request().query(`SELECT r.ROUTINE_SCHEMA AS [schema], r.ROUTINE_NAME AS name, p.PARAMETER_NAME AS paramName, p.DATA_TYPE AS paramType, p.PARAMETER_MODE AS paramMode, p.ORDINAL_POSITION AS ordinal FROM INFORMATION_SCHEMA.ROUTINES r LEFT JOIN INFORMATION_SCHEMA.PARAMETERS p ON p.SPECIFIC_SCHEMA = r.SPECIFIC_SCHEMA AND p.SPECIFIC_NAME = r.SPECIFIC_NAME WHERE r.ROUTINE_TYPE = 'PROCEDURE' ORDER BY r.ROUTINE_SCHEMA, r.ROUTINE_NAME, p.ORDINAL_POSITION`);
      const map = new Map();
      for (const row of r.recordset) {
        const key = `${row.schema}.${row.name}`;
        if (!map.has(key)) map.set(key, { schema: row.schema, name: row.name, params: [] });
        if (row.paramName) map.get(key).params.push({ name: row.paramName.replace(/^@/, ''), type: row.paramType, mode: row.paramMode || 'IN' });
      }
      res.json([...map.values()]);
    } else {
      const r = await connPgQuery(conn, db, `SELECT n.nspname AS schema, p.proname AS name, p.prokind AS prokind, pg_get_function_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.prokind IN ('f', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY n.nspname, p.proname`);
      res.json(r.rows.map(row => { let params = []; try { params = parsePgFunctionArgs(row.args); } catch { params = []; } return { schema: row.schema, name: row.name, kind: row.prokind === 'p' ? 'PROCEDURE' : 'FUNCTION', params }; }));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/conn/:id/columns', async (req, res) => {
  const conn = getConnOr404(req, res); if (!conn) return;
  const { db, schema, table } = req.query;
  if (!db || !table) return res.status(400).json({ error: 'db and table required' });
  try {
    if (conn.type === 'mssql') {
      const pool = await connMssqlPool(conn, db);
      const r = await pool.request()
        .input('schema', sql.NVarChar, schema || 'dbo')
        .input('table', sql.NVarChar, table)
        .query(`SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, COLUMNPROPERTY(OBJECT_ID(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME)), COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY, COLUMNPROPERTY(OBJECT_ID(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME)), COLUMN_NAME, 'IsComputed') AS IS_COMPUTED FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table ORDER BY ORDINAL_POSITION`);
      const fks = await mssqlFkMap(pool, schema || 'dbo', table);
      res.json(r.recordset.map(row => ({ name: row.COLUMN_NAME, type: formatMssqlType(row.DATA_TYPE, row.CHARACTER_MAXIMUM_LENGTH, row.NUMERIC_PRECISION, row.NUMERIC_SCALE), identity: row.IS_IDENTITY === 1 || row.IS_COMPUTED === 1, fk: fks[row.COLUMN_NAME] || null })));
    } else {
      const r = await connPgQuery(conn, db, { text: `SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, datetime_precision, is_identity, is_generated, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, values: [schema || 'public', table] });
      const pgp = await connPgPool(conn, db);
      const fks = await pgFkMap(pgp, schema || 'public', table);
      res.json(r.rows.map(row => ({ name: row.column_name, type: formatPgType(row.data_type, row.character_maximum_length, row.numeric_precision, row.numeric_scale, row.datetime_precision), identity: row.is_identity === 'YES' || row.is_generated === 'ALWAYS' || /^nextval\(/i.test(row.column_default || ''), fk: fks[row.column_name] || null })));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/conn/:id/query', async (req, res) => {
  const conn = getConnOr404(req, res); if (!conn) return;
  const { query, database } = req.body;
  const ip = clientIp(req);
  const auditBase = { side: conn.id, host: conn.mssqlConfig?.server || conn.pgConfig?.host, user: conn.mssqlConfig?.user || conn.pgConfig?.user, readOnly: conn.readOnly, db: database, query, clientIp: ip };
  if (!database) { auditLog({ ...auditBase, status: 'error', error: 'database required', durationMs: 0, statementCount: 0 }); return res.status(400).json({ error: 'database required' }); }
  if (conn.readOnly) {
    const v = violatesReadOnly(query);
    if (v) { auditLog({ ...auditBase, status: 'blocked', error: `Read-only blocked ${v}`, durationMs: 0, statementCount: 0 }); return res.status(403).json({ error: `Read-only profile blocked ${v} statement.` }); }
  }
  const statements = splitStatements(query);
  if (statements.length === 0) return res.json({ results: [], error: null });
  const t0 = Date.now();
  const results = [];

  if (conn.type === 'mssql') {
    const PRE  = 'DECLARE @__tc INT = @@TRANCOUNT; SET IMPLICIT_TRANSACTIONS OFF; SET XACT_ABORT ON;\n';
    const POST = '\n;WHILE @@TRANCOUNT > @__tc COMMIT TRAN; WHILE @@TRANCOUNT < @__tc BEGIN TRAN;';
    let request;
    try {
      const pool = await connMssqlPool(conn, database);
      request = pool.request();
      conn.mssqlCurrentRequest = request;
      for (const stmt of statements) {
        const sT = Date.now();
        const r = await request.query(PRE + stmt + POST);
        const rows = r.recordset || [];
        const columns = r.recordset?.columns ? Object.keys(r.recordset.columns) : (rows.length > 0 ? Object.keys(rows[0]) : []);
        const rowsAffected = Array.isArray(r.rowsAffected) ? r.rowsAffected.reduce((a, b) => a + (b || 0), 0) : (r.rowsAffected ?? rows.length);
        results.push({ statement: stmt, columns, rows, rowsAffected, durationMs: Date.now() - sT });
      }
      res.json({ results, error: null });
      auditLog({ ...auditBase, status: 'ok', statementCount: statements.length, rows: results.reduce((n, r) => n + r.rows.length, 0), durationMs: Date.now() - t0 });
    } catch (e) {
      const cancelled = /canceled/i.test(e.message);
      const errPayload = { statementIndex: results.length, message: cancelled ? 'Query cancelled' : e.message, code: e.code || e.number || null, lineNumber: e.lineNumber || e.originalError?.info?.lineNumber || null };
      res.status(cancelled ? 499 : 200).json({ results, error: errPayload });
      auditLog({ ...auditBase, status: cancelled ? 'cancelled' : 'error', error: e.message, statementCount: statements.length, failedAt: results.length, durationMs: Date.now() - t0 });
    } finally {
      if (conn.mssqlCurrentRequest === request) conn.mssqlCurrentRequest = null;
    }
  } else {
    let client, txOpen = false;
    try {
      const pool = await connPgPool(conn, database);
      client = await pool.connect();
      conn.pgCurrentPid = client.processID;
      await client.query(conn.readOnly ? 'BEGIN READ ONLY' : 'BEGIN'); txOpen = true;
      for (const stmt of statements) {
        const sT = Date.now();
        const r = await client.query(stmt);
        const columns = r.fields ? r.fields.map(f => f.name) : [];
        results.push({ statement: stmt, columns, rows: r.rows || [], rowsAffected: r.rowCount ?? 0, durationMs: Date.now() - sT });
      }
      await client.query('COMMIT'); txOpen = false;
      res.json({ results, error: null });
      auditLog({ ...auditBase, status: 'ok', statementCount: statements.length, rows: results.reduce((n, r) => n + r.rows.length, 0), durationMs: Date.now() - t0 });
    } catch (e) {
      const cancelled = /canceling statement due to user request/i.test(e.message);
      if (txOpen && client) { try { await client.query('ROLLBACK'); } catch {} }
      const errPayload = { statementIndex: results.length, message: cancelled ? 'Query cancelled' : e.message, code: e.code || null, position: e.position ? parseInt(e.position) : null, hint: e.hint || null };
      res.status(cancelled ? 499 : 200).json({ results, error: errPayload });
      auditLog({ ...auditBase, status: cancelled ? 'cancelled' : 'error', error: e.message, statementCount: statements.length, failedAt: results.length, durationMs: Date.now() - t0 });
    } finally {
      conn.pgCurrentPid = null;
      if (client) client.release();
    }
  }
});

app.get('/api/conn/:id/pk', async (req, res) => {
  const conn = getConnOr404(req, res); if (!conn) return;
  const { db, schema, table } = req.query;
  if (!db || !schema || !table) return res.status(400).json({ error: 'db, schema, table required' });
  try {
    if (conn.type === 'mssql') {
      res.json({ columns: await mssqlPkColumns(await connMssqlPool(conn, db), schema, table) });
    } else {
      const pool = await connPgPool(conn, db);
      const r = await pool.query(PG_PK_SQL, [schema, table]);
      res.json({ columns: r.rows.map(x => x.col) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/conn/:id/explain', async (req, res) => {
  const conn = getConnOr404(req, res); if (!conn) return;
  const { query, database } = req.body;
  if (!database) return res.status(400).json({ error: 'database required' });
  if (!query || !query.trim()) return res.status(400).json({ error: 'query required' });
  if (conn.type !== 'mssql') return res.status(400).json({ error: 'Estimated plan endpoint is SQL Server only; use EXPLAIN in the query for PostgreSQL.' });
  try {
    const pool = await connMssqlPool(conn, database);
    res.json(await mssqlEstimatedPlan(pool, query));
  } catch (e) {
    res.status(200).json({ results: [], error: { statementIndex: 0, message: e.message, code: e.number || null } });
  }
});

app.post('/api/conn/:id/cancel', async (req, res) => {
  const conn = getConnOr404(req, res); if (!conn) return;
  try {
    if (conn.type === 'mssql') {
      if (!conn.mssqlCurrentRequest) return res.json({ ok: false, reason: 'no active query' });
      conn.mssqlCurrentRequest.cancel();
      res.json({ ok: true });
    } else {
      if (!conn.pgCurrentPid) return res.json({ ok: false, reason: 'no active query' });
      await connPgQuery(conn, conn.pgPoolDb || 'postgres', `SELECT pg_cancel_backend(${parseInt(conn.pgCurrentPid)})`);
      res.json({ ok: true });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/conn/:id/ping', async (req, res) => {
  const conn = getConnOr404(req, res); if (!conn) return;
  const t0 = Date.now();
  try {
    if (conn.type === 'mssql') {
      const pool = await connMssqlPool(conn, 'master');
      await pool.request().query('SELECT 1 AS ok');
    } else {
      await connPgQuery(conn, conn.pgPoolDb || 'postgres', 'SELECT 1 AS ok');
    }
    res.json({ ok: true, latencyMs: Date.now() - t0 });
  } catch (e) { res.status(503).json({ ok: false, error: e.message, latencyMs: Date.now() - t0 }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const server = isNaN(parseInt(PORT))
  ? app.listen(PORT, () => {
      console.log(`\n  SQL Management → IIS (iisnode)\n`);
    })
  : app.listen(parseInt(PORT), HOST, () => {
      console.log(`\n  SQL Management → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
    });

async function shutdown(signal) {
  console.log(`\n  Received ${signal}, shutting down…`);
  server.close();
  clearInterval(sessionSweeper);
  // Every browser's pools, not just one shared set.
  for (const session of sessions.values()) {
    try { await closeSession(session); } catch {}
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { violatesReadOnly, splitStatements };
