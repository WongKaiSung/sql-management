const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const chartAsset = fs.existsSync(path.join(root, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js'))
  ? '/vendor/chart.js/dist/chart.umd.min.js'
  : '/vendor/chart.js/dist/chart.umd.js';

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

async function waitForReady(url, child, {
  attemptTimeoutMs = 1000,
  overallTimeoutMs = 30000,
  fetchFn = fetch,
} = {}) {
  const deadline = Date.now() + overallTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited before readiness (code ${child.exitCode})`);
    const controller = new AbortController();
    const remainingMs = deadline - Date.now();
    const abortTimer = setTimeout(() => controller.abort(), Math.min(attemptTimeoutMs, remainingMs));
    try {
      const response = await fetchFn(url, { signal: controller.signal });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(abortTimer);
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`server did not become ready: ${lastError?.message || 'timeout'}`);
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

test('readiness polling aborts a hung fetch attempt', { timeout: 500 }, async () => {
  let aborted = false;
  await assert.rejects(
    waitForReady('http://127.0.0.1:1', { exitCode: null }, {
      attemptTimeoutMs: 20,
      overallTimeoutMs: 100,
      fetchFn: (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('request aborted'));
        }, { once: true });
      }),
    }),
    /server did not become ready/,
  );
  assert.equal(aborted, true);
});

test('server serves the application, status, and local runtime assets', { timeout: 35000 }, async t => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    if (await waitForChildExit(child, 1000)) return;
    child.kill('SIGKILL');
    if (!await waitForChildExit(child, 1000)) {
      throw new Error('server did not exit after SIGTERM and SIGKILL');
    }
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(`${baseUrl}/`, child);

  for (const route of [
    '/',
    '/api/status',
    '/vendor/codemirror/lib/codemirror.js',
    '/vendor/sql-formatter/dist/sql-formatter.min.js',
    '/vendor/xlsx/dist/xlsx.full.min.js',
    chartAsset,
  ]) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200, `${route} should return HTTP 200`);
  }
});
