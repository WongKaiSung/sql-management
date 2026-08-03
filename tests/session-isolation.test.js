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

// A minimal cookie jar — one per simulated browser. fetch() in Node does not
// persist cookies, so each jar captures Set-Cookie and replays it, which is
// what makes two jars behave like two different people's browsers.
function makeBrowser(baseUrl) {
  const cookies = new Map();
  const headers = () => {
    const jar = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    return jar ? { cookie: jar } : {};
  };
  const absorb = response => {
    for (const raw of response.headers.getSetCookie?.() || []) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  };
  return {
    cookies,
    // For routes that legitimately fail in the test environment (the MSSQL
    // driver has no server to reach). Still absorbs the session cookie.
    async postExpectingFailure(route, body) {
      const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers() },
        body: JSON.stringify(body),
      });
      absorb(response);
      await response.json().catch(() => null);
    },
    async get(route) {
      const response = await fetch(`${baseUrl}${route}`, { headers: headers() });
      absorb(response);
      const payload = await response.json();
      assert.equal(response.status, 200, `GET ${route}: ${JSON.stringify(payload)}`);
      return payload;
    },
    async post(route, body) {
      const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers() },
        body: JSON.stringify(body),
      });
      absorb(response);
      const payload = await response.json();
      assert.equal(response.status, 200, `POST ${route}: ${JSON.stringify(payload)}`);
      return payload;
    },
  };
}

// One server for the whole file. Sessions are what isolate these tests from
// each other, so sharing a process is not only safe, it is the thing under test.
let baseUrl;
let child;

test.before(async () => {
  const port = await getFreePort();
  child = spawn(process.execPath, ['-r', './tests/fake-pg-read-only.js', 'server.js'], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: 'ignore',
  });
  baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(`${baseUrl}/api/status`, child);
});

test.after(async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 2000)) return;
  child.kill('SIGKILL');
  assert.equal(await waitForExit(child, 1000), true, 'test server should exit');
});

test('one browser switching PostgreSQL servers does not move every other browser', { timeout: 30000 }, async () => {

  const alice = makeBrowser(baseUrl);
  const bob = makeBrowser(baseUrl);

  await alice.get('/api/status');
  await bob.get('/api/status');
  assert.notEqual(alice.cookies.size, 0, 'server should hand each browser a session cookie');
  assert.notDeepEqual([...alice.cookies], [...bob.cookies], 'two browsers must not share one session');

  await alice.post('/api/pg/connect', { host: 'alpha.test', port: 5432, user: 'alice' });
  await bob.post('/api/pg/connect', { host: 'beta.test', port: 5433, user: 'bob' });

  const aliceStatus = await alice.get('/api/status');
  assert.equal(aliceStatus.pg.host, 'alpha.test', "Bob's connect must not move Alice's server");
  assert.equal(aliceStatus.pg.user, 'alice');
  assert.equal(aliceStatus.pg.port, 5432);

  const bobStatus = await bob.get('/api/status');
  assert.equal(bobStatus.pg.host, 'beta.test');
  assert.equal(bobStatus.pg.user, 'bob');
  assert.equal(bobStatus.pg.port, 5433);
});

test('one browser switching SQL Server slots does not move every other browser', { timeout: 30000 }, async () => {

  const alice = makeBrowser(baseUrl);
  const bob = makeBrowser(baseUrl);

  // The MSSQL driver is real, so opening the pool fails with no server to reach
  // — but the config is recorded before the pool opens, and that recorded config
  // is exactly what /api/status reports and what used to be shared by everyone.
  await alice.postExpectingFailure('/api/mssql/connect', { server: 'sql-alpha', user: 'alice' });
  await bob.postExpectingFailure('/api/mssql/connect', { server: 'sql-beta', user: 'bob' });

  const aliceStatus = await alice.get('/api/status');
  const bobStatus = await bob.get('/api/status');
  assert.equal(aliceStatus.ms.server, 'sql-alpha', "Bob's connect must not move Alice's SQL Server");
  assert.equal(aliceStatus.ms.user, 'alice');
  assert.equal(bobStatus.ms.server, 'sql-beta');
  assert.equal(bobStatus.ms.user, 'bob');
});

test('a read-only profile in one browser does not make another browser read-only', { timeout: 30000 }, async () => {

  const alice = makeBrowser(baseUrl);
  const bob = makeBrowser(baseUrl);

  await alice.post('/api/pg/connect', { host: 'alpha.test', user: 'alice', readOnly: false });
  await bob.post('/api/pg/connect', { host: 'beta.test', user: 'bob', readOnly: true });

  const aliceResult = await alice.post('/api/pg/query', { database: 'app', query: "SELECT nextval('order_id_seq')" });
  assert.equal(aliceResult.error, null, "Bob's read-only profile must not block Alice's writes");

  const bobResult = await bob.post('/api/pg/query', { database: 'app', query: "SELECT nextval('order_id_seq')" });
  assert.match(bobResult.error?.message || '', /read-only transaction/i, 'Bob stays read-only');
});

test('added connection panels are private to the browser that created them', { timeout: 30000 }, async () => {

  const alice = makeBrowser(baseUrl);
  const bob = makeBrowser(baseUrl);

  // Both browsers number their panels from c1, so the ids collide by design.
  await alice.post('/api/conn/c1/connect', { type: 'pg', host: 'alpha.test', user: 'alice' });
  await bob.post('/api/conn/c1/connect', { type: 'pg', host: 'beta.test', user: 'bob' });

  const aliceList = await alice.get('/api/conn/list');
  assert.deepEqual(aliceList.map(c => c.host), ['alpha.test'], "Alice must not see Bob's panel");

  const bobList = await bob.get('/api/conn/list');
  assert.deepEqual(bobList.map(c => c.host), ['beta.test'], "Bob must not see Alice's panel");
});
