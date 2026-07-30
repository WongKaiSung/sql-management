const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function classify(queries) {
  const program = `
    const server = require('./server');
    const queries = JSON.parse(process.argv[1]);
    const result = queries.map(([name, query]) => [
      name,
      typeof server.violatesReadOnly === 'function'
        ? server.violatesReadOnly(query)
        : '__MISSING_CLASSIFIER__',
    ]);
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ['-e', program, JSON.stringify(queries)], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0' },
  });

  assert.equal(child.status, 0, child.stderr);
  return Object.fromEntries(JSON.parse(child.stdout));
}

test('read-only gate admits only SELECT forms and blocks SQL write bypasses', () => {
  // Removing the classifier export, accepting an unknown statement, or missing
  // any write form below must fail this regression test.
  const results = classify([
    ['select', 'SELECT id, name FROM users'],
    ['cte select', 'WITH recent AS (SELECT id FROM events), active AS (SELECT id FROM users) SELECT * FROM recent'],
    ['nested cte select', 'WITH outer_rows AS (WITH inner_rows AS (SELECT 1 AS id) SELECT id FROM inner_rows) SELECT * FROM outer_rows'],
    ['recursive cte select', 'WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 3) SELECT * FROM numbers'],
    ['explain select', 'EXPLAIN (FORMAT JSON) SELECT id FROM users'],
    ['comments strings and quoted identifiers', "/* UPDATE ignored */ SELECT 'DELETE; COPY FROM' AS note, \"DROP\" AS quoted_name, [ALTER] AS bracket_name -- INSERT ignored\nFROM audit_log"],
    ['read-only batch', 'SELECT 1; /* comment */ SELECT 2'],
    ['insert', 'INSERT INTO users (name) VALUES (\'Ada\')'],
    ['update', 'UPDATE users SET name = \'Ada\''],
    ['delete', 'DELETE FROM users'],
    ['ddl', 'CREATE TABLE unsafe (id int)'],
    ['control', 'BEGIN TRANSACTION'],
    ['with update main', 'WITH target AS (SELECT id FROM users) UPDATE users SET name = \'Ada\' WHERE id IN (SELECT id FROM target)'],
    ['data writing cte', 'WITH changed AS (UPDATE users SET name = \'Ada\' RETURNING id) SELECT * FROM changed'],
    ['select into', 'SELECT id INTO copied_users FROM users'],
    ['copy from', "COPY users FROM '/tmp/users.csv'"],
    ['explain update', 'EXPLAIN UPDATE users SET name = \'Ada\''],
    ['multi statement bypass', 'SELECT 1; DELETE FROM users'],
    ['unknown', 'SHOW TABLES'],
    ['unterminated single quote', "SELECT 'unfinished"],
    ['unterminated double quote', 'SELECT "unfinished'],
    ['unterminated bracket quote', 'SELECT [unfinished'],
    ['unterminated block comment', 'SELECT 1 /* unfinished'],
    ['unterminated dollar string', 'SELECT $payload$unfinished'],
    ['unclosed parenthesis', 'SELECT (1 + 2'],
    ['unexpected close parenthesis', 'SELECT 1)'],
  ]);

  for (const name of [
    'select', 'cte select', 'nested cte select', 'recursive cte select',
    'explain select', 'comments strings and quoted identifiers', 'read-only batch',
  ]) {
    assert.equal(results[name], null, `${name} should be permitted`);
  }
  for (const name of [
    'insert', 'update', 'delete', 'ddl', 'control', 'with update main',
    'data writing cte', 'select into', 'copy from', 'explain update',
    'multi statement bypass', 'unknown', 'unterminated single quote',
    'unterminated double quote', 'unterminated bracket quote',
    'unterminated block comment', 'unterminated dollar string',
    'unclosed parenthesis', 'unexpected close parenthesis',
  ]) {
    assert.notEqual(results[name], null, `${name} must be blocked`);
  }
});
