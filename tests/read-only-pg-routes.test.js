const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForReady(url, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited before readiness (${child.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('server readiness timed out');
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

// Connection state is per browser session, so these requests must carry one
// session cookie throughout — they stand in for a single person's browser.
// Without the jar every request would land in a fresh session and the profile
// set up by /connect would not be the one /query runs against.
const cookies = new Map();

async function post(baseUrl, route, body) {
  const jar = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(jar ? { cookie: jar } : {}) },
    body: JSON.stringify(body),
  });
  for (const raw of response.headers.getSetCookie?.() || []) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  const payload = await response.json();
  assert.equal(response.status, 200, `${route}: ${JSON.stringify(payload)}`);
  return payload;
}

test('all PostgreSQL query routes enable database read-only mode only for read-only profiles', { timeout: 30000 }, async t => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['-r', './tests/fake-pg-read-only.js', 'server.js'], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    if (await waitForExit(child, 1000)) return;
    child.kill('SIGKILL');
    assert.equal(await waitForExit(child, 1000), true, 'test server should exit');
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(`${baseUrl}/api/status`, child);

  const routes = [
    {
      name: 'fixed PG',
      connect: readOnly => post(baseUrl, '/api/pg/connect', { host: 'pg.test', user: 'tester', readOnly }),
      query: () => post(baseUrl, '/api/pg/query', { database: 'app', query: "SELECT nextval('order_id_seq')" }),
    },
    {
      name: 'PG2',
      connect: readOnly => post(baseUrl, '/api/pg2/connect', { host: 'pg2.test', user: 'tester', readOnly }),
      query: () => post(baseUrl, '/api/pg2/query', { database: 'app', query: "SELECT nextval('order_id_seq')" }),
    },
    {
      name: 'dynamic PG',
      connect: readOnly => post(baseUrl, '/api/conn/c99/connect', { type: 'pg', host: 'dynamic.test', user: 'tester', readOnly }),
      query: () => post(baseUrl, '/api/conn/c99/query', { database: 'app', query: "SELECT nextval('order_id_seq')" }),
    },
  ];

  for (const route of routes) {
    await route.connect(false);
    const writable = await route.query();
    assert.equal(writable.error, null, `${route.name} writable profile should use an ordinary transaction`);

    await route.connect(true);
    const readOnly = await route.query();
    assert.match(
      readOnly.error?.message || '',
      /nextval.*read-only transaction/i,
      `${route.name} should ask PostgreSQL to reject SELECT side effects`,
    );
  }
});
