#!/usr/bin/env node
/**
 * reclaim-pg.js — diagnose and safely reclaim leaked PostgreSQL connections.
 *
 * Background: an earlier server.js used a single switched pg pool that leaked
 * orphaned pools on every db-switch. Killed node processes left those backends
 * "idle" on the PG server until it hit max_connections — symptom: "down" +
 * "Error loading DBs", hundreds of server-side clients but only ~1 in the app.
 *
 * SHARED SERVER SAFETY: this targets a remote/shared PostgreSQL, so by default
 * it only terminates idle connections coming FROM THIS MACHINE (matched on the
 * server-observed client address). Other people's connections are never touched,
 * and active queries / open transactions are always left alone. Do NOT restart a
 * shared PostgreSQL service to fix this — that drops everyone.
 *
 * Point it at the real server (the .env defaults to localhost, which may be wrong):
 *   node reclaim-pg.js --host=pnbdev.example --user=postgres --password=secret
 * (or set PGHOST/PGPORT/PGUSER/PGPASSWORD env vars; falls back to PG_* in .env)
 *
 * Usage:
 *   node reclaim-pg.js                 # diagnose only (read-only, safe)
 *   node reclaim-pg.js --kill          # terminate idle backends FROM THIS MACHINE
 *   node reclaim-pg.js --kill --app    # only this app's (application_name sqlconnect%)
 *   node reclaim-pg.js --kill --idle-min=2     # change idle-age threshold (default 5 min)
 *   node reclaim-pg.js --kill --all-idle       # ignore the idle-age threshold
 *   node reclaim-pg.js --kill --any-user       # DANGER: every idle conn for the user
 */
const path = require('path');
const fs = require('fs');
const { Client } = require('pg');

// Load .env the same way server.js does (no dotenv dependency)
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    });
  }
} catch {}

const args = process.argv.slice(2);
const has = f => args.includes(f);
const opt = (name, dflt) => {
  const a = args.find(x => x.startsWith('--' + name + '='));
  return a ? a.split('=').slice(1).join('=') : dflt;
};

const KILL = has('--kill');
const ALL_IDLE = has('--all-idle');
const ANY_USER = has('--any-user');
const APP_ONLY = has('--app');
const IDLE_MIN = parseFloat(opt('idle-min', '5'));

const cfg = {
  host: opt('host', process.env.PGHOST || process.env.PG_HOST || 'localhost'),
  port: parseInt(opt('port', process.env.PGPORT || process.env.PG_PORT || '5432')),
  user: opt('user', process.env.PGUSER || process.env.PG_USER || 'postgres'),
  password: opt('password', process.env.PGPASSWORD || process.env.PG_PASSWORD || ''),
  database: opt('db', 'postgres'),
  application_name: 'reclaim-pg',
  connectionTimeoutMillis: 8000,
};

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

(async () => {
  const client = new Client(cfg);
  try {
    await client.connect();
  } catch (e) {
    console.error('\n  Could not connect to ' + cfg.host + ':' + cfg.port + ' as ' + cfg.user + ': ' + (e.message || e.code || e));
    console.error('  Every slot (including superuser-reserved) appears taken, OR the host/credentials are wrong.');
    console.error('  Check you pointed --host/--user/--password at the SHARED server (not localhost),');
    console.error('  and ask a DBA to free a slot or bump max_connections if it is genuinely full.\n');
    process.exit(1);
  }

  const { rows: [{ mc }] } = await client.query("SELECT setting::int AS mc FROM pg_settings WHERE name='max_connections'");
  const { rows: [{ total }] } = await client.query('SELECT count(*)::int AS total FROM pg_stat_activity WHERE pid <> pg_backend_pid()');
  const { rows: [{ myaddr }] } = await client.query("SELECT coalesce(inet_client_addr()::text,'local') AS myaddr");

  console.log('\n  Server ' + cfg.host + ':' + cfg.port + '   max_connections=' + mc + '   in use=' + total + '   free=' + (mc - total - 1));
  console.log('  This machine is seen by the server as client address: ' + myaddr + '\n');

  // Breakdown by where connections come from - the key view on a shared server.
  const { rows: byAddr } = await client.query(
    "SELECT coalesce(client_addr::text,'local') AS addr, count(*)::int AS n, " +
    "count(*) FILTER (WHERE state='idle')::int AS idle, " +
    "count(*) FILTER (WHERE state='active')::int AS active " +
    "FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type='client backend' " +
    "GROUP BY 1 ORDER BY n DESC LIMIT 25");
  console.log('  ' + pad('CLIENT ADDRESS',24) + pad('TOTAL',8) + pad('IDLE',8) + 'ACTIVE');
  console.log('  ' + '-'.repeat(52));
  for (const r of byAddr) {
    const mark = (r.addr === myaddr) ? '   <-- THIS MACHINE' : '';
    console.log('  ' + pad(r.addr,24) + pad(r.n,8) + pad(r.idle,8) + pad(r.active,7) + mark);
  }

  // Also break down by user/app for context.
  const { rows: bd } = await client.query(
    "SELECT coalesce(usename,'(none)') AS usename, " +
    "coalesce(nullif(application_name,''),'(blank)') AS app, state, count(*)::int AS n " +
    "FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type='client backend' " +
    "GROUP BY 1,2,3 ORDER BY n DESC LIMIT 25");
  console.log('\n  ' + pad('USER',16) + pad('APPLICATION',22) + pad('STATE',20) + 'COUNT');
  console.log('  ' + '-'.repeat(64));
  for (const r of bd) console.log('  ' + pad(r.usename,16) + pad(r.app,22) + pad(r.state || '(null)',20) + r.n);

  // Build the termination filter.
  // Default (safest): idle backends FROM THIS MACHINE. --app narrows to
  // application_name sqlconnect%. --any-user widens to every idle conn (DANGER).
  const ageClause = ALL_IDLE ? '' : "AND state_change < now() - interval '" + IDLE_MIN + " minutes'";
  let scopeClause, params, scopeLabel;
  if (ANY_USER) {
    scopeClause = 'AND usename = $1';
    params = [cfg.user];
    scopeLabel = "ALL idle '" + cfg.user + "' connections (every machine!)";
  } else if (APP_ONLY) {
    scopeClause = "AND application_name LIKE 'sqlconnect%' AND coalesce(client_addr::text,'local') = $1";
    params = [myaddr];
    scopeLabel = "idle 'sqlconnect%' connections from this machine";
  } else {
    scopeClause = "AND coalesce(client_addr::text,'local') = $1";
    params = [myaddr];
    scopeLabel = 'idle connections from this machine (' + myaddr + ')';
  }
  const filterSQL =
    ' FROM pg_stat_activity WHERE pid <> pg_backend_pid()' +
    " AND backend_type = 'client backend' AND state = 'idle' " + scopeClause + ' ' + ageClause;

  const { rows: cand } = await client.query('SELECT count(*)::int AS n ' + filterSQL, params);
  const candCount = cand[0].n;
  console.log('\n  Reclaim candidates (' + scopeLabel + (ALL_IDLE ? '' : ', idle > ' + IDLE_MIN + ' min') + '): ' + candCount);

  if (!KILL) {
    console.log('  Dry run - nothing terminated. Re-run with --kill to terminate these.\n');
    await client.end();
    return;
  }
  if (ANY_USER) console.log('  WARNING: --any-user terminates idle connections from EVERY machine for this user.');
  if (candCount === 0) { console.log('  Nothing to terminate.\n'); await client.end(); return; }

  const { rows: killed } = await client.query('SELECT count(*) FILTER (WHERE pg_terminate_backend(pid)) AS n ' + filterSQL, params);
  const { rows: [{ total: after }] } = await client.query('SELECT count(*)::int AS total FROM pg_stat_activity WHERE pid <> pg_backend_pid()');
  console.log('  Terminated ' + killed[0].n + ' idle backend(s).   Now in use=' + after + '   free=' + (mc - after - 1) + '\n');
  await client.end();
})().catch(e => { console.error(e); process.exit(1); });
