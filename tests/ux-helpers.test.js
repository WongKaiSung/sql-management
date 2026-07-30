const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  WORKSPACE_VERSION,
  WORKSPACE_CATEGORIES,
  classifyEnvironment,
  sanitizeProfile,
  buildWorkspacePayload,
  validateWorkspacePayload,
  mergeWorkspaceData,
  mergeProfilesPreservingSecrets,
  applyWorkspaceOperations,
  pushRecovery,
  chooseActivePanel,
  panelLayoutForMode,
  workspacePaneRailState,
  planDynamicPaneClose,
  sanitizePanelLayout,
} = require('../public/ux-helpers.js');

test('workspace validation rejects malicious ids and normalizes only safe pane records', () => {
  const payload = {
    version: 1,
    data: {
      savedQueries: [{ id: 1, name: 'Safe', sql: 'SELECT 1' }, { id: '0);alert(1)//', name: 'Bad', sql: 'SELECT 2' }, { id: 1, name: 'Duplicate', sql: 'SELECT 3' }],
      sqlSnippets: [{ id: 2, name: 'Snippet', text: 'SELECT 1' }, { id: Infinity, name: 'Bad', text: 'x' }],
      queryTabs: { ms: { tabs: [{ id: 3, name: 'Q', content: 'SELECT 1' }, { id: '0);alert(1)//', name: 'Bad', content: 'x' }], activeId: 3 }, 'c12': { tabs: [{ id: 4, name: 'D', content: 'SELECT 2' }], activeId: 4 }, evil: { tabs: [{ id: 5, name: 'x', content: 'x' }] } },
      queryHistory: { pg: [{ query: 'SELECT 1', db: 'db', ts: 1, rows: 1, ms: 2 }], 'c12': [{ query: 'SELECT 2', ts: 2 }], '0);alert(1)//': [{ query: 'bad', ts: 3 }] },
    },
  };
  const result = validateWorkspacePayload(payload);

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.data.savedQueries, [{ id: 1, name: 'Safe', sql: 'SELECT 1' }]);
  assert.deepEqual(result.value.data.sqlSnippets, [{ id: 2, name: 'Snippet', text: 'SELECT 1' }]);
  assert.deepEqual(Object.keys(result.value.data.queryTabs), ['ms', 'c12']);
  assert.deepEqual(Object.keys(result.value.data.queryHistory), ['pg', 'c12']);
});

test('profile imports retain passwords for matching saved profile names', () => {
  const merged = mergeProfilesPreservingSecrets(
    [{ name: 'Reporting', server: 'old', password: 'keep-me' }, { name: 'Other', password: 'other-secret' }],
    [{ name: 'Reporting', server: 'new' }, { name: 'New profile', server: 'fresh' }],
  );
  assert.deepEqual(merged, [{ name: 'Reporting', server: 'new', password: 'keep-me' }, { name: 'New profile', server: 'fresh' }]);
});

test('workspace operations roll back applied writes after a later failure', () => {
  const values = { first: 'old', second: 'old' };
  const result = applyWorkspaceOperations([
    { apply: () => { values.first = 'new'; }, rollback: () => { values.first = 'old'; } },
    { apply: () => { throw new Error('quota'); }, rollback: () => { values.second = 'old'; } },
  ]);
  assert.equal(result.ok, false);
  assert.equal(values.first, 'old');
  assert.equal(result.rollbackFailed, false);
});

test('sanitizeProfile normalizes hostile attribute strings without retaining executable markup', () => {
  const profile = sanitizeProfile({
    name: 'x" onclick="alert(1)', server: 'db" onmouseover="alert(1)', host: 7, user: '<img onerror=1>',
    port: '1433', readOnly: 'yes', type: 'mssql', password: 'secret',
  });
  assert.deepEqual(profile, { name: 'x onclick=alert(1)', server: 'db onmouseover=alert(1)', user: 'img onerror=1', port: 1433, readOnly: true, type: 'mssql' });
});

test('workspace helpers enforce the explicit non-secret category allow-list', () => {
  const current = { theme: 'dark', savedQueries: [{ id: 1, name: 'Old', sql: 'SELECT old' }], sqlSnippets: [{ id: 2, name: 'Keep', text: 'SELECT keep' }] };
  const incoming = {
    savedQueries: [{ id: 3, name: 'New', sql: 'SELECT new' }], theme: 'light', unknown: ['ignore'],
    password: 'ignore', connectionString: 'Server=db;Password=hidden',
  };
  const merged = mergeWorkspaceData(current, incoming, ['savedQueries', new String('unknown'), 'password']);

  assert.deepEqual(WORKSPACE_CATEGORIES, [
    'msProfiles', 'pgProfiles', 'savedQueries', 'sqlSnippets', 'queryTabs', 'queryHistory',
    'theme', 'paneLayout', 'preferences',
  ]);
  assert.deepEqual(merged, { theme: 'dark', savedQueries: [{ id: 3, name: 'New', sql: 'SELECT new' }], sqlSnippets: [{ id: 2, name: 'Keep', text: 'SELECT keep' }] });
  merged.savedQueries[0].name = 'Changed';
  assert.equal(incoming.savedQueries[0].name, 'New');
  assert.equal(current.savedQueries[0].name, 'Old');
});

test('classifyEnvironment identifies whole production markers across profile metadata', () => {
  assert.equal(classifyEnvironment({ name: 'Sales PROD' }), 'production');
  assert.equal(classifyEnvironment({ server: 'sql-production-01' }), 'production');
  assert.equal(classifyEnvironment({ host: 'Pg.Prod.Internal' }), 'production');
  assert.equal(classifyEnvironment({ profileName: 'PRODUCTION reporting' }), 'production');
  assert.equal(classifyEnvironment({ database: 'warehouse_prod' }), 'production');
  assert.equal(classifyEnvironment({ name: 'product-catalog' }), 'standard');
  assert.equal(classifyEnvironment({ name: 'preproduction' }), 'standard');
});

test('sanitizeProfile keeps only allowed fields without mutating the profile', () => {
  const profile = {
    name: 'Primary', type: 'mssql', server: 'db.internal', host: 'db.internal',
    port: 1433, user: 'reporter', readOnly: true, password: 'secret',
    connectionString: 'Server=db;Password=secret', connStr: 'Password=secret', extra: 'drop',
  };

  assert.deepEqual(sanitizeProfile(profile), {
    name: 'Primary', type: 'mssql', server: 'db.internal', host: 'db.internal',
    port: 1433, user: 'reporter', readOnly: true,
  });
  assert.equal(profile.password, 'secret');
});

test('buildWorkspacePayload sanitizes profiles and preserves input data', () => {
  const data = {
    msProfiles: [{ name: 'MS', server: 'sql-01', password: 'hidden', notes: 'drop' }],
    pgProfiles: [{ name: 'PG', host: 'pg-01', connStr: 'hidden' }],
    sqlSnippets: [{ id: 1, name: 'Useful', text: 'SELECT 1' }],
  };

  const payload = buildWorkspacePayload(data, '2026-07-28T00:00:00.000Z');

  assert.equal(WORKSPACE_VERSION, 1);
  assert.deepEqual(payload, {
    version: 1,
    exportedAt: '2026-07-28T00:00:00.000Z',
    data: {
      msProfiles: [{ name: 'MS', server: 'sql-01' }],
      pgProfiles: [{ name: 'PG', host: 'pg-01' }],
      sqlSnippets: [{ id: 1, name: 'Useful', text: 'SELECT 1' }],
    },
  });
  assert.equal(data.msProfiles[0].password, 'hidden');
  assert.equal(data.pgProfiles[0].connStr, 'hidden');
});

test('buildWorkspacePayload removes secrets from ordinary data at every depth', () => {
  const data = {
    preferences: {
      title: 'Keep this',
      password: 'nested-password',
      connectionString: 'Server=sql-02;Pwd=hidden',
      auth: { label: 'Keep this too', clientSecret: 'nested-secret', authorization: 'Bearer hidden' },
    },
    savedQueries: [
      { id: 1, name: 'Safe', sql: 'SELECT 1', token: 'hidden-token', label: 'Keep array data' },
      'Server=sql-03;Password=hidden',
    ],
  };
  Object.defineProperty(data.preferences, '__proto__', {
    value: { polluted: true }, enumerable: true,
  });

  const payload = buildWorkspacePayload(data, '2026-07-28T00:00:00.000Z');

  assert.deepEqual(payload.data, {
    preferences: {
      title: 'Keep this',
      auth: { label: 'Keep this too' },
    },
    savedQueries: [{ id: 1, name: 'Safe', sql: 'SELECT 1' }],
  });
  assert.equal(data.preferences.auth.clientSecret, 'nested-secret');
  assert.equal(data.savedQueries[1], 'Server=sql-03;Password=hidden');
});

test('validateWorkspacePayload accepts version 1 and rejects invalid workspace shapes', () => {
  const valid = { version: 1, data: { sqlSnippets: [] } };
  assert.deepEqual(validateWorkspacePayload(valid), { ok: true, value: valid });
  assert.deepEqual(validateWorkspacePayload([]), { ok: false, error: 'Invalid SQLConnect workspace file' });
  assert.deepEqual(validateWorkspacePayload({ version: 1 }), { ok: false, error: 'Invalid SQLConnect workspace file' });
  assert.deepEqual(validateWorkspacePayload({ version: 2, data: {} }), {
    ok: false, error: 'Unsupported workspace version: 2',
  });
  assert.deepEqual(validateWorkspacePayload({ version: 1, data: { unknown: [] } }), {
    ok: false, error: 'Workspace file contains no supported data',
  });
});

test('mergeWorkspaceData replaces only listed categories with safe deep clones', () => {
  const current = { theme: 'dark', sqlSnippets: [{ id: 1, name: 'Old', text: 'old' }], savedQueries: [{ id: 2, name: 'Current', sql: 'current' }] };
  const incoming = JSON.parse('{"theme":"light","sqlSnippets":[{"id":3,"name":"New","text":"new"}],"savedQueries":[{"id":4,"name":"Incoming","sql":"incoming"}],"__proto__":{"polluted":true},"constructor":{"polluted":true}}');

  const merged = mergeWorkspaceData(current, incoming, ['sqlSnippets', '__proto__', 'constructor']);

  assert.deepEqual(merged, { theme: 'dark', sqlSnippets: [{ id: 3, name: 'New', text: 'new' }], savedQueries: [{ id: 2, name: 'Current', sql: 'current' }] });
  assert.equal({}.polluted, undefined);
  merged.sqlSnippets[0].name = 'Changed';
  assert.equal(incoming.sqlSnippets[0].name, 'New');
  assert.equal(current.sqlSnippets[0].name, 'Old');
});

test('mergeWorkspaceData rejects object-wrapped unsafe category names', () => {
  const incoming = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"polluted":true},"savedQueries":[{"id":1,"name":"Incoming","sql":"incoming","__proto__":{"polluted":true}}]}');
  const merged = mergeWorkspaceData(
    { savedQueries: [{ id: 2, name: 'Current', sql: 'current' }] },
    incoming,
    [new String('__proto__'), new String('constructor'), new String('savedQueries')],
  );

  assert.deepEqual(merged, { savedQueries: [{ id: 1, name: 'Incoming', sql: 'incoming' }] });
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal({}.polluted, undefined);
  merged.savedQueries[0].name = 'Changed';
  assert.equal(incoming.savedQueries[0].name, 'Incoming');
});

test('pushRecovery prepends newest items with default and custom limits without mutation', () => {
  const stack = Array.from({ length: 10 }, (_, index) => `old-${index}`);
  const recovered = pushRecovery(stack, 'new');

  assert.deepEqual(recovered, ['new', 'old-0', 'old-1', 'old-2', 'old-3', 'old-4', 'old-5', 'old-6', 'old-7', 'old-8']);
  assert.equal(stack.length, 10);
  assert.deepEqual(pushRecovery(['older', 'oldest'], 'new', 2), ['new', 'older']);
});

test('chooseActivePanel prefers a visible choice and falls back predictably', () => {
  assert.equal(chooseActivePanel('pg', ['ms', 'pg']), 'pg');
  assert.equal(chooseActivePanel('missing', ['ms', 'pg']), 'ms');
  assert.equal(chooseActivePanel('ms', []), null);
});

test('single-panel layout ignores the saved workspace ratio', () => {
  assert.deepEqual(panelLayoutForMode('ms', 0.2), {
    mode: 'ms', msFlex: '1 1 100%', pgFlex: '', dividerVisible: false, ratio: 0.2,
  });
  assert.deepEqual(panelLayoutForMode('pg', 0.8), {
    mode: 'pg', msFlex: '', pgFlex: '1 1 100%', dividerVisible: false, ratio: 0.8,
  });
});

test('workspace layout restores and clamps its saved ratio', () => {
  assert.deepEqual(panelLayoutForMode('both', 0.2), {
    mode: 'both', msFlex: '0.2 1 0', pgFlex: '0.8 1 0', dividerVisible: true, ratio: 0.2,
  });
  assert.equal(panelLayoutForMode('both', 0.95).ratio, 0.8);
  assert.equal(panelLayoutForMode('both', null).ratio, 0.5);
  assert.equal(panelLayoutForMode('both', 'invalid').ratio, 0.5);
});

test('workspace pane rail reports primary and extra panes', () => {
  assert.deepEqual(workspacePaneRailState([], 'ms'), {
    hasExtras: false, dynamicCount: 0, paneCount: 2,
    countLabel: '2 panes', activeId: 'ms', closeExtrasDisabled: true,
  });
  assert.deepEqual(workspacePaneRailState(['c1', 'c2'], 'c2'), {
    hasExtras: true, dynamicCount: 2, paneCount: 4,
    countLabel: '4 panes · 2 extra', activeId: 'c2', closeExtrasDisabled: false,
  });
});

test('bulk pane close separates closable, dirty, and running panes', () => {
  assert.deepEqual(planDynamicPaneClose([
    { id: 'c1', dirty: false, running: false },
    { id: 'c2', dirty: true, running: false },
    { id: 'c3', dirty: true, running: true },
  ]), {
    closableIds: ['c1', 'c2'], runningIds: ['c3'], dirtyCount: 1,
    prompt: 'Close 2 extra panes? 1 pane contains query text.',
  });
  assert.deepEqual(planDynamicPaneClose([]), {
    closableIds: [], runningIds: [], dirtyCount: 0, prompt: '',
  });
});

test('sanitizePanelLayout keeps only safe dynamic-pane metadata without mutating input', () => {
  const panels = [
    {
      id: ' c12 ', engine: 'ms', profileName: ' Main ', title: ' Reporting ', width: 640.6,
      password: 'hidden', connectionString: 'Server=db;Password=hidden', host: 'db', server: 'db',
      user: 'reporter', port: 1433, database: 'app', token: 'hidden', nested: { secret: 'hidden' },
    },
    { id: 'c12', engine: 'pg', title: 'duplicate' },
    { id: 'c13', engine: 'pg', profileName: ' '.repeat(121) + 'x', title: 'x'.repeat(121), width: 320 },
    { id: 'c14', engine: 'oracle', width: 500 },
    { id: 'bad', engine: 'ms', width: 500 },
    { id: 'c15', engine: 'pg', width: 319.9 },
    { id: 'c16', engine: 'pg', width: Infinity },
    Object.assign(Object.create(null), { id: 'c17', engine: 'ms', width: 400 }),
  ];
  const polluted = JSON.parse('{"id":"c18","engine":"ms","__proto__":{"polluted":true}}');
  panels.push(polluted);

  const result = sanitizePanelLayout(panels);

  assert.deepEqual(result, [
    { id: 'c12', engine: 'ms', profileName: 'Main', title: 'Reporting', width: 641 },
    { id: 'c13', engine: 'pg', profileName: 'x', title: 'x'.repeat(120), width: 320 },
    { id: 'c15', engine: 'pg' },
    { id: 'c16', engine: 'pg' },
  ]);
  assert.notEqual(result, panels);
  assert.equal(panels[0].password, 'hidden');
  assert.deepEqual(panels[0].nested, { secret: 'hidden' });
  assert.equal({}.polluted, undefined);
});

test('sanitizePanelLayout rejects malformed input and unsafe record prototypes', () => {
  assert.deepEqual(sanitizePanelLayout(null), []);
  assert.deepEqual(sanitizePanelLayout({ id: 'c1', engine: 'ms' }), []);
  assert.deepEqual(sanitizePanelLayout([
    null, [], 'c1', Object.create({ id: 'c1', engine: 'ms' }), { id: 1, engine: 'ms' },
  ]), []);
});

test('ux helpers attach to window in a browser-like runtime', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'ux-helpers.js'), 'utf8');
  const browserWindow = {};

  vm.runInNewContext(source, { window: browserWindow });

  assert.equal(browserWindow.SQLConnectUX.WORKSPACE_VERSION, 1);
  assert.equal(typeof browserWindow.SQLConnectUX.buildWorkspacePayload, 'function');
  assert.equal(typeof browserWindow.SQLConnectUX.sanitizePanelLayout, 'function');
});
