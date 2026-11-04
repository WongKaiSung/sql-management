const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'public', 'index.html');
const readHtml = () => fs.readFileSync(htmlPath, 'utf8');
const count = (text, pattern) => (text.match(pattern) || []).length;

test('index.html contains no NUL bytes', () => {
  const htmlBytes = fs.readFileSync(htmlPath);

  assert.equal(htmlBytes.includes(0), false);
});

test('index.html ends with exactly one final HTML newline', () => {
  const html = readHtml();

  assert.match(html, /<\/html>\r?\n$/);
  assert.doesNotMatch(html, /<\/html>\r?\n\r?\n$/);
});

test('public shell uses SQL Management branding without changing compatibility identifiers', () => {
  const html = readHtml();

  assert.match(html, /<title>SQL Management<\/title>/);
  assert.match(html, /<h1>SQL Management<\/h1>/);
  assert.match(html, /SQL Management could not start the query editor\./);
  assert.match(html, /sql-management-workspace-/);
  assert.match(html, /SQLConnectUX/);
  assert.match(html, /sqlconnectWorkspacePanels:v1/);
  assert.match(html, /sqlconnectWorkspaceBackup:v1/);
});

test('runtime assets use the complete local vendor set', () => {
  const html = readHtml();
  const expectedAssets = [
    '/vendor/codemirror/lib/codemirror.min.css',
    '/vendor/codemirror/theme/dracula.min.css',
    '/vendor/codemirror/theme/eclipse.min.css',
    '/vendor/codemirror/lib/codemirror.min.js',
    '/vendor/codemirror/mode/sql/sql.min.js',
    '/vendor/codemirror/addon/edit/matchbrackets.min.js',
    '/vendor/codemirror/addon/display/placeholder.min.js',
    '/vendor/codemirror/addon/comment/comment.min.js',
    '/vendor/sql-formatter/dist/sql-formatter.min.js',
  ];

  for (const asset of expectedAssets) {
    assert.match(html, new RegExp(`(?:src|href)=["']${asset}["']`));
  }

  assert.match(html, /["']\/vendor\/chart\.js\/dist\/chart\.umd\.js["']/);
  assert.doesNotMatch(html, /\/vendor\/xlsx\//);
  assert.doesNotMatch(html, /\bdownloadXLSX\b/);
  assert.doesNotMatch(html, /\bXlsxBtn\b/);
  assert.doesNotMatch(html, />↓ XLSX</);
});

test('runtime scripts and stylesheets do not use remote URLs', () => {
  const remoteAssetCount = count(
    readHtml(),
    /<(?:script|link)\b[^>]+(?:src|href)=["']https:\/\//gi,
  );

  assert.equal(remoteAssetCount, 0);
});

test('charts derive UI colors, refresh open charts, and invalidate stale async renders', () => {
  const html = readHtml();
  const chartStart = html.indexOf('function chartThemeColors()');
  const chartTheme = html.slice(chartStart, html.indexOf('async function explainSide', chartStart));
  const applyThemeStart = html.indexOf('function applyTheme(pref)');
  const applyTheme = html.slice(applyThemeStart, html.indexOf('function cycleTheme()', applyThemeStart));

  assert.ok(chartStart >= 0, 'chartThemeColors is available to the chart renderer');
  assert.match(chartTheme, /getComputedStyle\(document\.documentElement\)/);
  for (const variable of ['--text', '--text-muted', '--border', '--blue', '--surface']) {
    assert.match(chartTheme, new RegExp(variable));
  }
  assert.doesNotMatch(chartTheme, /#c9d1d9|#8b949e/);
  assert.match(chartTheme, /legend[\s\S]*?labels[\s\S]*?color\s*:\s*theme\./);
  assert.match(chartTheme, /ticks\s*:\s*\{\s*color\s*:\s*theme\./);
  assert.match(chartTheme, /grid\s*:\s*\{\s*color\s*:\s*theme\./);
  assert.match(applyTheme, /_chartInstance[\s\S]*?renderChart\(\)/);
  assert.match(html, /_chartRenderVersion\s*=\s*0/);
  assert.match(chartTheme, /const\s+renderVersion\s*=\s*\+\+_chartRenderVersion/);
  assert.match(chartTheme, /await\s+loadScriptOnce\(CHART_CDN\);[\s\S]*?renderVersion\s*!==\s*_chartRenderVersion[\s\S]*?return/);
  const close = html.slice(html.indexOf('function closeChart()'), html.indexOf('async function renderChart()', chartStart));
  assert.match(close, /\+\+_chartRenderVersion/);
  assert.match(close, /_chartSide\s*=\s*null/);
});

test('startup dependency failures are visible and stop editor initialization', () => {
  const html = readHtml();
  const startupStart = html.indexOf('function checkStartupDependencies()');
  const startup = html.slice(startupStart, html.indexOf('// â”€â”€ Init', startupStart));
  const initStart = html.indexOf("window.addEventListener('DOMContentLoaded', async () => {");
  const init = html.slice(initStart, html.indexOf('// â”€â”€ Table browser', initStart));

  assert.match(html, /id=["']startupError["'][^>]*role=["']alert["'][^>]*hidden/i);
  assert.match(html, /id=["']startupErrorMessage["']/i);
  assert.match(html, /<button[^>]*onclick=["']location\.reload\(\)["'][^>]*>\s*Reload\s*<\/button>/i);
  assert.ok(startupStart >= 0, 'startup dependency check is defined');
  for (const globalName of ['CodeMirror', 'sqlFormatter', 'SQLConnectUX']) {
    assert.match(startup, new RegExp(globalName));
  }
  assert.match(startup, /CodeMirror\.defaults[\s\S]*?matchBrackets/);
  assert.match(startup, /CodeMirror matchBrackets addon/);
  assert.match(startup, /startupError[\s\S]*?hidden\s*=\s*false/);
  assert.match(startup, /startupErrorMessage[\s\S]*?local assets/i);
  assert.match(init, /const\s+missingDependencies\s*=\s*checkStartupDependencies\(\);\s*if\s*\(missingDependencies\.length\)\s*return;[\s\S]*?initEditors\(\)/);
});

test('accessible workbench shell and active-pane contracts are present', () => {
  const html = readHtml();
  const header = html.match(/<header\b[\s\S]*?<\/header>/i)?.[0] || '';
  const directHeader = header.replace(/<div\b[^>]*id=["']appToolsMenu["'][\s\S]*?<\/div>/i, '');

  assert.match(html, /<main\b[^>]*>/i);
  assert.match(html, /<button\b[^>]*id=["']modeMsBtn["'][^>]*>\s*SQL Server\s*<\/button>/i);
  assert.match(html, /<button\b[^>]*id=["']modePgBtn["'][^>]*>\s*PostgreSQL\s*<\/button>/i);
  assert.match(html, /id=["']appToolsBtn["'][^>]*aria-haspopup=["']menu["'][^>]*aria-controls=["']appToolsMenu["'][^>]*aria-expanded=/i);
  assert.match(html, /<div\b[^>]*id=["']appToolsMenu["'][^>]*role=["']menu["']/i);
  for (const label of ['Decompress', 'Text compare', 'Query Library', 'Keyboard shortcuts', 'Theme']) {
    assert.match(header, new RegExp(`<[^>]+role=["']menuitem["'][^>]*>[^<]*${label}`, 'i'));
    assert.doesNotMatch(directHeader, new RegExp(`>[^<]*${label}`, 'i'));
  }
  for (const side of ['ms', 'pg']) {
    const ledger = new RegExp(`<[^>]+class=["'][^"']*connection-ledger[^"']*["'][^>]*id=["']${side}Ledger["'][^>]*aria-live=["']polite["'][^>]*>[\\s\\S]*?id=["']${side}LedgerEnv["'][\\s\\S]*?id=["']${side}LedgerConnection["'][\\s\\S]*?id=["']${side}LedgerDatabase["'][\\s\\S]*?id=["']${side}LedgerSafety["'][\\s\\S]*?id=["']${side}LedgerHealth["']`, 'i');
    assert.equal(count(html, new RegExp(`class=["'][^"']*connection-ledger[^"']*["'][^>]*id=["']${side}Ledger["']`, 'gi')), 1);
    assert.match(html, ledger);
  }
  assert.match(html, /id=["']toast-container["'][^>]*aria-live=["']polite["'][^>]*aria-atomic=["']false["']/i);
  for (const name of ['let activePanelId', 'setActivePanel', 'visiblePanelIds', 'targetSide', 'toggleAppMenu', 'closeAppMenus', 'renderConnectionLedger']) {
    assert.match(html, new RegExp(name.replace(/[()]/g, '\\$&')));
  }
  assert.match(html, /function\s+_targetSide\s*\(\s*\)\s*\{\s*return\s+targetSide\s*\(\s*\)\s*;?\s*\}/);
});

test('workspace comparison and visible execution contracts are present', () => {
  const html = readHtml();
  const compare = html.match(/<section\b[^>]*id=["']comparePanel["'][\s\S]*?<\/section>/i)?.[0] || '';
  const menu = html.match(/<div\b[^>]*id=["']appToolsMenu["'][\s\S]*?<\/div>/i)?.[0] || '';
  const comparableStart = html.indexOf('function listComparableResults()');
  const comparable = html.slice(comparableStart, html.indexOf('function resolveSource', comparableStart));
  const executionStart = html.indexOf('async function executeVisible()');
  const visibleExecution = html.slice(executionStart, html.indexOf('// ── Table browser', executionStart));

  for (const id of ['comparePanel', 'srcASelect', 'srcBSelect', 'aKeyCol', 'bKeyCol', 'diffOnly', 'mappingRows', 'compareStats', 'compareScroll']) {
    assert.equal(count(html, new RegExp(`id=["']${id}["']`, 'gi')), 1, `${id} is unique`);
  }
  assert.match(compare, /role=["']region["'][^>]*aria-labelledby=["']compareTitle["']/i);
  for (const control of ['closeCompare', 'onCompareSourceChange', 'renderComparison', 'addMapping', 'compareStats', 'compareScroll']) {
    assert.match(compare, new RegExp(control));
  }
  // Comparison survives the removal of multi-pane view: it reads explicitly
  // captured snapshots, not live panes, so it works one pane at a time.
  assert.match(menu, /role=["']menuitem["'][^>]*onclick=["']openCompare\(\)["'][^>]*>\s*Compare results/i);
  assert.match(comparable, /for\s*\(const\s+side\s+of\s+panelIds\(\)\)/);
  assert.match(comparable, /compareSnapshots/);
  assert.doesNotMatch(comparable, /Object\.keys\(state\)|\[['"]ms['"],\s*['"]pg['"]\]/);
  assert.match(visibleExecution, /visiblePanelIds\(\)/);
  assert.match(visibleExecution, /detectDestructive/);
  assert.match(visibleExecution, /openVisibleDestructiveReview\(targets/);
  assert.match(visibleExecution, /Promise\.allSettled/);
  assert.match(html, /function\s+setMode\s*\(mode\)[\s\S]*?dynamicPanels/);
  assert.match(html, /function\s+setMode\s*\(mode\)[\s\S]*?updateWorkspaceActions\(/);
});

test('recovery, query library, and workspace portability contracts are present', () => {
  const html = readHtml();
  const tools = html.match(/<div\b[^>]*id=["']appToolsMenu["'][\s\S]*?<\/div>/i)?.[0] || '';

  assert.match(html, /function\s+showToast\s*\(\s*message\s*,\s*type\s*=\s*'info'\s*,\s*persist\s*=\s*false\s*,\s*action\s*=\s*null\s*\)/);
  assert.match(html, /toast-action/);
  assert.match(html, /function\s+undoClear\s*\(/);
  assert.match(html, /function\s+reopenClosedTab\s*\(/);
  assert.match(html, /sqlconnectRecentlyClosedTabs:v1/);
  assert.match(html, /SQLConnectUX\.pushRecovery/);
  assert.match(html, /function\s+openQueryLibrary\s*\(/);
  assert.match(html, /openSavedQueries\s*\(\)\s*\{\s*openQueryLibrary\('saved'\)/);
  assert.match(html, /id=["']queryLibraryTitle["']/);
  assert.match(html, /Saved queries.*Snippets.*History.*Recently closed/s);
  assert.match(html, /Download \.sql/);
  assert.match(tools, /Export workspace/);
  assert.match(tools, /Import workspace/);
  assert.match(html, /id=["']workspaceImportInput["'][^>]*type=["']file["']/);
  assert.match(html, /Passwords are excluded/);
  for (const name of ['exportWorkspace', 'previewWorkspaceImport', 'applyWorkspaceImport', 'buildWorkspacePayload', 'validateWorkspacePayload', 'mergeWorkspaceData']) {
    assert.match(html, new RegExp(name));
  }
  assert.match(html, /id=["']workspaceImportDialog["']/);
  assert.match(html, /sqlconnectWorkspaceBackup:v1/);
});

test('Task 7 recovery and import hardening contracts are present', () => {
  const html = readHtml();
  assert.match(html, /originalTabId/);
  assert.match(html, /engine:\s*srvType\(side\)/);
  assert.match(html, /findCompatibleReopenSide/);
  assert.match(html, /sanitizeWorkspacePaneIds/);
  assert.match(html, /applyWorkspaceOperations/);
  assert.match(html, /mergeProfilesPreservingSecrets/);
  assert.match(html, /New profiles need credentials/);
  assert.doesNotMatch(html, /_libraryInsert\(_getSavedQueries\(\)\.find\(x=>x\.id===\$\{/);
  assert.doesNotMatch(html, /loadSavedQuery\(\$\{q\.id\}\)/);
});

test('Task 7 Fix Round 2 profile and backup recovery contracts are present', () => {
  const html = readHtml();
  assert.match(html, /function\s+restoreWorkspaceBackup\s*\(/);
  assert.match(html, /Restore pre-import backup/);
  assert.match(html, /WORKSPACE_BACKUP_KEY/);
  assert.match(html, /panelRatio/);
  assert.match(html, /function\s+escAttr\s*\(/);
  assert.match(html, /dataset\.profile/);
  assert.match(html, /tabResult.*view|view:.*tabResult/s);
});

test('undoClear keeps recovered view state with its tab result, not the active pane state', () => {
  const html = readHtml();
  const start = html.indexOf('function undoClear(side)');
  const undo = html.slice(start, html.indexOf('function clearSide(side)', start));

  assert.match(undo, /tabResult.*view|view:.*snapshot\.view/s);
  assert.doesNotMatch(undo, /if\s*\(snapshot\.view\)\s*viewState\[side \+ 'Results'\]\s*=/);
});

test('tab result recovery preserves the outer and statement-level view namespace', () => {
  const html = readHtml();
  const saveStart = html.indexOf('function _saveTabResult(');
  const save = html.slice(saveStart, html.indexOf('function _restoreTabResult(', saveStart));
  const restoreStart = html.indexOf('function _restoreTabResult(');
  const restore = html.slice(restoreStart, html.indexOf('function saveEditorToTab(', restoreStart));

  assert.match(html, /__stmt/);
  assert.match(save, /viewNamespace/);
  assert.match(restore, /viewNamespace/);
  assert.match(html, /function\s+restoreResultViewNamespace[\s\S]*?rerenderResults/);
});

test('result namespace cleanup prevents a stale second statement view from leaking', () => {
  const html = readHtml();
  const captureStart = html.indexOf('function captureResultViewNamespace(');
  const capture = html.slice(captureStart, html.indexOf('function restoreResultViewNamespace(', captureStart));
  const renderStart = html.indexOf('function renderMultiResults(');
  const render = html.slice(renderStart, html.indexOf('function setupHScrollOverlay(', renderStart));

  assert.match(capture, /results.*columns/);
  assert.match(capture, /stmt\$\{index\}/);
  assert.match(render, /delete viewState\[k\]/);
  assert.match(render, /delete renderState\[k\]/);
});

test('result sets expose a durable comparison snapshot action', () => {
  const html = readHtml();
  const renderStart = html.indexOf('function renderMultiResults(');
  const renderer = html.slice(renderStart, html.indexOf('// Sticky horizontal scrollbar', renderStart));
  const captureStart = html.indexOf('function captureResultSnapshot(');
  const capture = html.slice(captureStart, html.indexOf('// ── Query Tabs', captureStart));

  assert.match(renderer, /captureResultSnapshot\(side,\s*idx\)/);
  assert.match(renderer, /Snapshot/);
  assert.match(capture, /compareSnapshots\.push/);
  assert.match(capture, /structuredClone/);
  assert.match(capture, /engine:\s*srvType\(side\)/);
  assert.match(capture, /updateWorkspaceActions\(\)/);
});

test('dynamic panes use the shared profile workflow and expose fixed-pane controls', () => {
  const html = readHtml();
  const template = html.match(/function\s+panelTemplateHTML\s*\(id\)\s*\{[\s\S]*?\n\}/)?.[0] || '';

  for (const name of ['WORKSPACE_PANELS_KEY', 'savePanelLayout', 'restorePanelLayout', 'openDynamicConnModal', 'connectDynamicPanel', 'renderDynamicProfilePicker']) {
    assert.match(html, new RegExp(name));
  }
  for (const suffix of ['SrvTypeSelect', 'ProfileSelect', 'ConnectBtn', 'DbSelect', 'RecentDbs', 'Ledger', 'LedgerEnv', 'LedgerConnection', 'LedgerDatabase', 'LedgerSafety', 'LedgerHealth', 'Sidebar', 'SidebarResize', 'Search', 'TabBar', 'HistoryPopover', 'SnippetsPopover', 'SqlEditor', 'Results', 'FindInput', 'CellPreview', 'CopyBtn', 'DownloadBtn', 'CopyJsonBtn', 'DownloadJsonBtn', 'ChartBtn']) {
    assert.match(template, new RegExp(`\\$\\{id\\}${suffix}`));
  }
  for (const control of ['History', 'Snippets', 'Format', 'Download .sql', 'Open', 'Explain', 'Run', 'Cancel', 'Clear', 'Paste as VALUES', 'connection-ledger', 'editor-divider', 'sidebar-resize']) {
    assert.match(template, new RegExp(control.replace('.', '\\.')));
  }
  assert.match(template, /aria-live="polite"/);
  assert.doesNotMatch(template, /Conn(?:Host|User|Pass)|type="password"|connection-string/i);
  assert.match(html, /function\s+addPanel\s*\(engine\s*=\s*'ms',\s*options\s*=\s*\{\}\)/);
  assert.match(html, /wirePanelActivation\(id\)[\s\S]*?savePanelLayout\(\)/);
  assert.match(html, /initEditors\(\)[\s\S]*?await\s+restorePanelLayout\(\)/);
  assert.match(html, /async\s+function\s+closePanel[\s\S]*?confirm\([^)]*query tabs/i);
});

test('dynamic pane sidebar, profile, and engine lifecycles stay pane-scoped', () => {
  const html = readHtml();
  const init = html.match(/function\s+initPanelState\s*\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
  const close = html.match(/async\s+function\s+closePanel\s*\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
  const setType = html.match(/function\s+setPanelSrvType\s*\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
  const profileConnect = html.match(/async\s+function\s+connectDynamicProfile\s*\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
  const modal = html.match(/async\s+function\s+openDynamicConnModal\s*\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
  const connect = html.match(/async\s+function\s+connectDynamicPanel\s*\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0] || '';

  for (const map of ['expandedTables', 'collapsedSchemas', 'collapsedGroups']) {
    assert.match(init, new RegExp(`${map}\\[id\\]`));
    assert.match(close, new RegExp(`delete\\s+${map}\\[id\\]`));
  }
  assert.match(html, /const\s+all\s*=\s*state\[side\]\?\.tables\s*\|\|\s*\[\]/);
  assert.match(html, /const\s+tables\s*=\s*state\[side\]\?\.tables\s*\|\|\s*\[\]/);
  assert.match(profileConnect, /try\s*\{\s*(?:return\s+)?await\s+connectDynamicPanel/);
  assert.match(profileConnect, /showToast\([^)]*Connect failed/);
  assert.match(modal, /ProfileName.*profile(?:Input)?\.name|profile(?:Input)?\.name.*ProfileName/s);
  assert.match(connect, /existingProfile.*password|password.*existingProfile/s);
  assert.match(setType, /if\s*\(dynamicPanels\[side\]\)\s*\{[\s\S]*?renderConnectionLedger\(side\)[\s\S]*?return;/);
});

test('Task 8 accessible workbench interaction contracts are present', () => {
  const html = readHtml();
  const template = html.match(/function\s+panelTemplateHTML\s*\(id\)\s*\{[\s\S]*?\n\}/)?.[0] || '';

  for (const name of ['openAppDialog', 'closeAppDialog', 'trapDialogFocus', 'enhancePaneAccessibility', 'resizeByKeyboard']) {
    assert.match(html, new RegExp(`function\\s+${name}\\s*\\(`));
  }
  for (const id of ['connModal', 'inspectorModal', 'decompressToolModal', 'compareToolModal', 'shortcutsModal', 'savedQModal', 'workspaceImportDialog', 'chartModal']) {
    assert.match(html, new RegExp(`id=["']${id}["'][^>]*role=["']dialog["'][^>]*aria-modal=["']true["'][^>]*aria-labelledby=["']`, 'i'));
  }
  assert.match(html, /role=["']tablist["']/i);
  assert.match(html, /role=["']tab["'][\s\S]*?aria-selected[\s\S]*?aria-controls/i);
  assert.match(html, /role=["']tabpanel["'][\s\S]*?aria-labelledby/i);
  assert.match(html, /role=["']tree["']/i);
  assert.match(html, /aria-expanded=/i);
  assert.match(html, /aria-label=["'](?:Table|Result) actions/i);
  assert.match(template, /aria-label=["'](?:Table|Result) actions/i);
  for (const selector of ['.panel-divider', '.sidebar-resize', '.editor-divider']) {
    assert.match(html, new RegExp(`${selector.replace('.', '\\.')}`));
  }
  assert.match(html, /role=["']separator["'][\s\S]*?aria-valuenow[\s\S]*?resizeByKeyboard/i);
  for (const query of ['@media (max-width: 1199px)', '@media (max-width: 799px)', '@media (prefers-reduced-motion: reduce)']) {
    assert.match(html, new RegExp(query.replace(/[()]/g, '\\$&')));
  }
  assert.match(html, /:focus-visible[\s\S]*?(?:button|input|select|\[role=["']menuitem)/i);
  assert.match(html, /\.sr-only\s*\{/);
});

test('Task 8 Fix Round 1 keeps browser actions data-safe and keyboard complete', () => {
  const html = readHtml();
  const browserStart = html.indexOf('function renderTableItems(');
  const browser = html.slice(browserStart, html.indexOf('// ── Search/filter', browserStart));
  const resizeStart = html.indexOf('function resizeByKeyboard(');
  const resize = html.slice(resizeStart, html.indexOf('function renderTabs(', resizeStart));
  const closeStart = html.indexOf('function closeTab(');
  const close = html.slice(closeStart, html.indexOf('function findCompatibleReopenSide', closeStart));
  const actionsStart = html.indexOf('function showResultActions(');
  const actions = html.slice(actionsStart, html.indexOf('function _quoteIdent', actionsStart));
  const addStart = html.indexOf('function addPanel(');
  const add = html.slice(addStart, html.indexOf('async function closePanel', addStart));

  assert.match(html, /function\s+browserActionFromElement\s*\(/);
  assert.match(html, /function\s+safeBrowserKeydown\s*\(/);
  assert.match(browser, /data-schema=.*escAttr/);
  assert.match(browser, /data-name=.*escAttr/);
  assert.doesNotMatch(browser, /onclick=["'][^"']*insert(?:Table|View|Proc)Query\([^)]*\$\{/);
  assert.match(browser, /role="treeitem"[^>]*tabindex="0"/);
  assert.match(browser, /column-item[^>]*role="treeitem"[^>]*tabindex="0"/);
  assert.match(add, /dynamic-divider/);
  assert.match(add, /setAttribute\('role', 'separator'\)/);
  assert.match(add, /aria-orientation.*vertical/);
  assert.match(resize, /dynamic-divider/);
  assert.match(resize, /savePanelLayout\(\)/);
  assert.match(close, /replacement.*focus|focus\(\)/);
  assert.match(actions, /lastIndex.*columns|findLastIndex/);
  assert.match(html, /ArrowDown.*ArrowUp.*Home.*End/s);
  assert.match(html, /const invoker = _contextInvoker[\s\S]*?invoker\.focus/);
  assert.match(actions, /insertProcQuery/);
});

test('browser identifier attribute escaping neutralizes hostile names', () => {
  const html = readHtml();
  const helper = html.match(/function esc\(s\)\s*\{[\s\S]*?\}\s*function escAttr\(s\)\s*\{[\s\S]*?\}/)?.[0] || '';
  const escAttr = Function(`${helper}; return escAttr;`)();
  for (const hostile of ["x');alert(1);//", '"/><img src=x>', 'schema\\name']) {
    const value = escAttr(hostile);
    assert.doesNotMatch(value, /[<>"']/);
  }
});

test('Task 8 Fix Round 2 keeps fixed separator values synchronized and bounded', () => {
  const html = readHtml();
  const sidebar = html.slice(html.indexOf('function initSidebarResizer('), html.indexOf('// ── Sidebar keyboard navigation', html.indexOf('function initSidebarResizer(')));
  const panel = html.slice(html.indexOf('function initPanelSplitter('), html.indexOf('// ── Editor / results splitter', html.indexOf('function initPanelSplitter(')));
  const editor = html.slice(html.indexOf('function initEditorSplitter('), html.indexOf('// ── Connection health probes', html.indexOf('function initEditorSplitter(')));
  const keyboard = html.slice(html.indexOf('function resizeByKeyboard('), html.indexOf('function renderTabs(', html.indexOf('function resizeByKeyboard(')));

  for (const source of [sidebar, panel, editor]) {
    assert.match(source, /aria-valuenow/);
    assert.match(source, /setAttribute\('aria-valuenow'/);
  }
  assert.match(sidebar, /dblclick[\s\S]*?aria-valuenow/);
  assert.match(panel, /onDoubleClick[\s\S]*?aria-valuenow/);
  assert.match(editor, /onDoubleClick[\s\S]*?aria-valuenow/);
  assert.match(keyboard, /getAttribute\('aria-valuemin'\)/);
  assert.match(keyboard, /getAttribute\('aria-valuemax'\)/);
  assert.match(keyboard, /Math\.min\(max/);
});

test('Task 8 Fix Round 3 clamps fixed splitter restore and pointer bounds to ARIA limits', () => {
  const html = readHtml();
  const availability = html.slice(html.indexOf('function syncPanelDividerAvailability('), html.indexOf('function initPanelSplitter(', html.indexOf('function syncPanelDividerAvailability(')));
  const panel = html.slice(html.indexOf('function initPanelSplitter('), html.indexOf('// ── Editor / results splitter', html.indexOf('function initPanelSplitter(')));
  const editor = html.slice(html.indexOf('function initEditorSplitter('), html.indexOf('// ── Connection health probes', html.indexOf('function initEditorSplitter(')));

  assert.match(availability, /Math\.max\(0\.2, Math\.min\(0\.8, Number\.isFinite\(saved\) \? saved/);
  assert.match(panel, /Math\.max\(PANEL_MIN_PX, totalWidth \* 0\.2\)/);
  assert.match(panel, /Math\.min\(totalWidth - PANEL_MIN_PX, totalWidth \* 0\.8\)/);
  assert.match(panel, /localStorage\.setItem\('panelRatio'/);
  assert.match(editor, /getAttribute\('aria-valuemin'\)/);
  assert.match(editor, /getAttribute\('aria-valuemax'\)/);
  assert.match(editor, /Math\.max\(min, Math\.min\(max, saved\)\)/);
  assert.match(editor, /localStorage\.setItem\(`\$\{EDITOR_HEIGHT_KEY\}:\$\{side\}`/);
});

test('Task 8 Fix Round 4 disables fixed splitting when responsive width is impossible', () => {
  const html = readHtml();
  const panel = html.slice(html.indexOf('function syncPanelDividerAvailability('), html.indexOf('// ── Editor / results splitter', html.indexOf('function syncPanelDividerAvailability(')));
  const keyboard = html.slice(html.indexOf('function resizeByKeyboard('), html.indexOf('function renderTabs(', html.indexOf('function resizeByKeyboard(')));

  assert.match(html, /function\s+syncPanelDividerAvailability\s*\(/);
  assert.match(panel, /2 \* PANEL_MIN_PX/);
  assert.match(panel, /aria-disabled/);
  assert.match(panel, /msPanel\.style\.flex = ''/);
  assert.match(panel, /pgPanel\.style\.flex = ''/);
  assert.match(panel, /window\.addEventListener\('resize'/);
  assert.match(panel, /setTimeout/);
  assert.match(panel, /Math\.max\(0\.2, Math\.min\(0\.8/);
  assert.match(keyboard, /aria-disabled.*true/);
  assert.match(panel, /onMouseDown[\s\S]*?aria-disabled/);
});

test('Final Fix B keeps a dynamic pane alive until an in-flight query settles', () => {
  const html = readHtml();
  const execution = html.slice(html.indexOf('async function executeSide('), html.indexOf('function executeMs()', html.indexOf('async function executeSide(')));
  const close = html.slice(html.indexOf('async function closePanel('), html.indexOf('// └── NEW FEATURES', html.indexOf('async function closePanel(')));

  assert.match(execution, /runState\[side\]\.inFlight\s*=\s*true/);
  assert.match(execution, /runState\[side\]\.inFlight\s*=\s*true;[\s\S]*?await\s+defaultQueryForActive\(side\)/);
  assert.match(execution, /finally\s*\{[\s\S]*?runState\[side\]\.inFlight\s*=\s*false/);
  assert.match(close, /runState\[id\]\?\.inFlight/);
  assert.match(close, /Cancel.*wait.*close|query is running/i);
  assert.match(close, /panel\.closing\s*=\s*true/);
});

test('Final Fix B reviews every visible target in an escaped application dialog', () => {
  const html = readHtml();
  const executionStart = html.indexOf('async function executeVisible()');
  const execution = html.slice(executionStart, html.indexOf('async function runVisibleTargets(', executionStart));
  const review = html.slice(html.indexOf('function openVisibleDestructiveReview('), html.indexOf('async function runVisibleTargets(', html.indexOf('function openVisibleDestructiveReview(')));

  assert.match(html, /id=["']visibleDestructiveReview["'][^>]*role=["']dialog["'][^>]*aria-modal=["']true["']/i);
  assert.match(html, /id=["']visibleDestructiveReviewTargets["']/i);
  assert.match(html, /Cancel[\s\S]*Run all/i);
  assert.doesNotMatch(execution, /confirm\(/);
  assert.match(execution, /openVisibleDestructiveReview\(targets/);
  for (const field of ['comparePaneLabel', 'srvLabel', 'profile', 'danger', 'sqlPreview', 'esc\\(']) {
    assert.match(review, new RegExp(field));
  }
  assert.match(review, /state\[side\]\?\.db/);
  assert.match(review, /openAppDialog\('visibleDestructiveReview'/);
  assert.match(html, /function\s+runVisibleDestructiveReview\s*\(/);
});

test('Final Fix B makes dynamic database failures pane-local and recoverable', () => {
  const html = readHtml();
  const load = html.slice(html.indexOf('async function loadDatabasesFor('), html.indexOf('async function closePanel(', html.indexOf('async function loadDatabasesFor(')));

  assert.match(html, /function\s+renderDynamicDatabaseError\s*\(/);
  assert.match(load, /renderDynamicDatabaseError\(side, e\)/);
  assert.match(load, /databaseError\s*=\s*null/);
  assert.match(html, /function\s+retryDynamicDatabases\s*\(/);
  assert.match(html, /function\s+copyDynamicDatabaseError\s*\(/);
  assert.match(html, /if\s*\(!navigator\.clipboard\?\.writeText\)\s*return\s+showToast/);
  assert.match(html, /Retry[\s\S]*Edit connection[\s\S]*Copy details/i);
  assert.match(html, /textContent\s*=\s*String\(error/);
});

test('Final Fix B Fix 1 invalidates stale dynamic database-list continuations', () => {
  const html = readHtml();
  const load = html.slice(html.indexOf('async function loadDatabasesFor('), html.indexOf('async function closePanel(', html.indexOf('async function loadDatabasesFor(')));
  const modal = html.slice(html.indexOf('async function openDynamicConnModal('), html.indexOf('async function connectDynamicProfile(', html.indexOf('async function openDynamicConnModal(')));
  const close = html.slice(html.indexOf('async function closePanel('), html.indexOf('// ── NEW FEATURES', html.indexOf('async function closePanel(')));

  assert.match(html, /function\s+beginPaneLoad\s*\(/);
  assert.match(html, /function\s+isPaneLoadCurrent\s*\(/);
  assert.match(load, /const\s+generation\s*=\s*beginPaneLoad\(side\)/);
  assert.match(load, /await\s+api[\s\S]*?if\s*\(!isPaneLoadCurrent\(side, generation\)\)\s*return\s+false/);
  assert.match(load, /catch[\s\S]*?if\s*\(!isPaneLoadCurrent\(side, generation\)\)\s*return\s+false/);
  assert.match(modal, /invalidatePaneLoads\(side\)/);
  assert.match(close, /invalidatePaneLoads\(id\)[\s\S]*?await\s+api/);
});

test('Final Fix B Fix 1 ignores stale table-list results for every pane', () => {
  const html = readHtml();
  const start = html.indexOf('async function onDbChange(');
  const change = html.slice(start, html.indexOf('async function onMsDbChange(', start));

  assert.match(change, /const\s+generation\s*=\s*beginPaneLoad\(side\)/);
  assert.match(change, /await\s+Promise\.all[\s\S]*?if\s*\(!isPaneLoadCurrent\(side, generation\)\)\s*return/);
  assert.match(change, /catch[\s\S]*?if\s*\(!isPaneLoadCurrent\(side, generation\)\)\s*return/);
  assert.doesNotMatch(change, /dynamicPanels\[side\][\s\S]*?isPaneLoadCurrent/);
});

test('Final Fix B Fix 1 routes destructive-review Escape through cancellation cleanup', () => {
  const html = readHtml();
  const start = html.indexOf('function trapDialogFocus(');
  const trap = html.slice(start, html.indexOf('document.addEventListener', start));

  assert.match(trap, /event\.key\s*===\s*'Escape'[\s\S]*?dialog\.id\s*===\s*'visibleDestructiveReview'[\s\S]*?cancelVisibleDestructiveReview\(\)/);
});

test('Final Fix B Fix 1 releases preparation inFlight before destructive confirmation', () => {
  const html = readHtml();
  const start = html.indexOf('async function executeSide(');
  const execution = html.slice(start, html.indexOf('function executeMs()', start));
  const preparationEnd = execution.indexOf('const danger = detectDestructive(query)');
  const preparation = execution.slice(0, preparationEnd);

  assert.match(preparation, /try\s*\{[\s\S]*?await\s+defaultQueryForActive\(side\)[\s\S]*?\}\s*finally\s*\{[\s\S]*?inFlight\s*=\s*false/);
  assert.doesNotMatch(preparation, /catch\s*\(error\)[\s\S]*?throw error/);
  assert.match(execution.slice(preparationEnd), /confirm\(/);
});

test('Final Fix B Fix 2 invalidates loads before every dynamic connection identity change', () => {
  const html = readHtml();
  const engineStart = html.indexOf('async function changeDynamicEngine(');
  const engine = html.slice(engineStart, html.indexOf('async function openDynamicConnModal(', engineStart));
  const profileStart = html.indexOf('async function connectDynamicProfile(');
  const profile = html.slice(profileStart, html.indexOf('async function connectDynamicPanel(', profileStart));
  const connectStart = html.indexOf('async function connectDynamicPanel(');
  const connect = html.slice(connectStart, html.indexOf('function _panelExtraKeys(', connectStart));

  assert.match(engine, /invalidatePaneLoads\(side\)[\s\S]*?await\s+api/);
  assert.match(profile, /invalidatePaneLoads\(side\)[\s\S]*?if\s*\(!profile\)/);
  assert.match(connect, /invalidatePaneLoads\(side\)[\s\S]*?await\s+api\([^)]*\/connect/);
});

test('Final Fix B Fix 3 serializes connection identity operations per pane', () => {
  const html = readHtml();

  assert.match(html, /const\s+paneIdentityOperations\s*=\s*\{\}/);
  assert.match(html, /function\s+beginPaneIdentityOperation\s*\(/);
  assert.match(html, /function\s+queuePaneIdentityOperation\s*\(/);
  assert.match(html, /function\s+isPaneIdentityCurrent\s*\(/);
  assert.match(html, /control\.tail[\s\S]*?\.then\(/);
});

test('Final Fix B Fix 3 captures connection input and validates ownership after awaits', () => {
  const html = readHtml();
  const engineStart = html.indexOf('async function changeDynamicEngine(');
  const engine = html.slice(engineStart, html.indexOf('async function openDynamicConnModal(', engineStart));
  const profileStart = html.indexOf('async function connectDynamicProfile(');
  const profile = html.slice(profileStart, html.indexOf('async function connectDynamicPanel(', profileStart));
  const connectStart = html.indexOf('async function connectDynamicPanel(');
  const connect = html.slice(connectStart, html.indexOf('function _panelExtraKeys(', connectStart));

  assert.match(engine, /beginPaneIdentityOperation\(side\)[\s\S]*?queuePaneIdentityOperation/);
  assert.match(engine, /await\s+api[\s\S]*?if\s*\(!isPaneIdentityCurrent\(side, operation\)\)\s*return\s+false/);
  assert.match(profile, /const\s+profileInput\s*=\s*\{\s*\.\.\.profile\s*\}/);
  assert.match(profile, /if\s*\(!profile\)[\s\S]*?queuePaneIdentityOperation/);
  const queueAt = connect.indexOf('queuePaneIdentityOperation');
  assert.ok(queueAt > connect.indexOf('const source ='), 'connection input is captured before queueing');
  assert.ok(queueAt > connect.indexOf('const saveProfile ='), 'save-profile choice is captured before queueing');
  assert.match(connect, /await\s+api\([^)]*\/connect[\s\S]*?if\s*\(!isPaneIdentityCurrent\(side, operation\)\)\s*return\s+false/);
  assert.match(connect, /await\s+loadDatabasesFor\(side\)[\s\S]*?if\s*\(!isPaneIdentityCurrent\(side, operation\)\)\s*return\s+false/);
});

test('Final Fix B Fix 3 makes pane close the final queued identity operation', () => {
  const html = readHtml();
  const start = html.indexOf('async function closePanel(');
  const close = html.slice(start, html.indexOf('// ── NEW FEATURES', start));

  assert.match(close, /invalidatePaneIdentityOperations\(id\)/);
  assert.match(close, /await\s+waitForPaneIdentityOperations\(id\)[\s\S]*?await\s+api\([^)]*\/disconnect/);
  assert.match(close, /await\s+api[\s\S]*?dynamicPanels\[id\]\s*!==\s*panel[\s\S]*?return/);
});

test('Final Fix B Fix 4 makes dynamic modal setup queued and newest-owned', () => {
  const html = readHtml();
  const modalStart = html.indexOf('async function openConnModal(');
  const modal = html.slice(modalStart, html.indexOf('function closeConnModal(', modalStart));
  const dynamicStart = html.indexOf('async function openDynamicConnModal(');
  const dynamic = html.slice(dynamicStart, html.indexOf('async function connectDynamicProfile(', dynamicStart));

  assert.match(html, /let\s+connModalOwner\s*=\s*null/);
  assert.match(modal, /modalOwner\s*=\s*null/);
  assert.match(modal, /beginConnModalRequest\(modalOwner\)/);
  assert.match(modal, /await\s+api\('\/api\/status'\)[\s\S]*?isConnModalRequestCurrent\(requestGeneration, panel, modalOwner\)/);
  assert.match(dynamic, /const\s+engine\s*=\s*panel\.engine/);
  assert.match(dynamic, /const\s+profileInput\s*=\s*profile\s*\?\s*\{\s*\.\.\.profile\s*\}\s*:\s*null/);
  assert.match(dynamic, /beginPaneIdentityOperation\(side\)[\s\S]*?queuePaneIdentityOperation/);
  assert.match(dynamic, /await\s+openConnModal\([^;]*modalRequest\)[\s\S]*?if\s*\(!isPaneIdentityCurrent\(side, operation\)/);
  assert.match(dynamic, /isConnModalRequestOwnerCurrent\(modalRequest, operation\)[\s\S]*?closeConnModal\(\)/);
  assert.match(dynamic, /isPaneIdentityCurrent[\s\S]*?connModalTitle/);
});

test('Final Fix B Fix 5 versions fixed and dynamic connection modal requests', () => {
  const html = readHtml();
  const modalStart = html.indexOf('async function openConnModal(');
  const modal = html.slice(modalStart, html.indexOf('async function saveConn(', modalStart));
  const dynamicStart = html.indexOf('async function openDynamicConnModal(');
  const dynamic = html.slice(dynamicStart, html.indexOf('async function connectDynamicProfile(', dynamicStart));
  const dialogStart = html.indexOf('function trapDialogFocus(');
  const dialog = html.slice(dialogStart, html.indexOf('document.addEventListener', dialogStart));

  assert.match(html, /let\s+connModalRequestGeneration\s*=\s*0/);
  assert.match(html, /function\s+beginConnModalRequest\([^)]*\)[\s\S]*?\+\+connModalRequestGeneration/);
  assert.match(html, /function\s+isConnModalRequestOwnerCurrent\([^)]*\)[\s\S]*?requestGeneration\s*===\s*connModalRequestGeneration/);
  assert.match(modal, /modalRequest\s*=\s*null[\s\S]*?modalRequest\s*\?\?\s*beginConnModalRequest\(modalOwner\)/);
  assert.match(modal, /await\s+api\('\/api\/status'\)[\s\S]*?if\s*\(!isConnModalRequestCurrent\(requestGeneration, panel, modalOwner\)\)\s*return\s+false/);
  assert.match(modal, /function\s+closeConnModal\(\)[\s\S]*?invalidateConnModalRequest\(\)[\s\S]*?closeAppDialog\('connModal'\)/);
  assert.match(dialog, /dialog\.id\s*===\s*'connModal'[\s\S]*?closeConnModal\(\)/);
  assert.match(dynamic, /const\s+modalRequest\s*=\s*beginConnModalRequest\(operation\)[\s\S]*?queuePaneIdentityOperation/);
  assert.match(dynamic, /isConnModalRequestCurrent\(modalRequest, side, operation\)[\s\S]*?await\s+openConnModal\([^;]*modalRequest\)/);
  assert.match(dynamic, /isConnModalRequestOwnerCurrent\(modalRequest, operation\)[\s\S]*?closeConnModal\(\)/);
});

test('connection submission only closes or writes errors to its captured modal owner', () => {
  const html = readHtml();
  const start = html.indexOf('async function connectDynamicPanel(');
  const connect = html.slice(start, html.indexOf('function _panelExtraKeys(', start));

  assert.match(connect, /submittedFromModal[\s\S]*?beginPaneIdentityOperation\(side\)/);
  assert.match(connect, /modalRequest[\s\S]*?beginConnModalRequest\(operation\)/);
  assert.match(connect, /ownsSubmittedModal[\s\S]*?isConnModalRequestCurrent\(modalRequest, side, operation\)/);
  assert.match(connect, /await\s+api\([^;]+\/connect[\s\S]*?ownsSubmittedModal\(\)[\s\S]*?closeConnModal\(\)/);
  assert.match(connect, /catch\s*\(error\)[\s\S]*?ownsSubmittedModal\(\)[\s\S]*?connError/);
  assert.doesNotMatch(connect, /closeModalOnSuccess/);
});

test('fixed connection submission captures modal context across its connect await', () => {
  const html = readHtml();
  const start = html.indexOf('async function saveConn()');
  const save = html.slice(start, html.indexOf('function resultsToCSV', start));
  const openStart = html.indexOf('async function openConnModal(');
  const open = html.slice(openStart, start);

  assert.match(open, /connSaveBtn[\s\S]*?disabled\s*=\s*false[\s\S]*?textContent\s*=\s*'Connect'/);
  assert.match(save, /submittedSide\s*=\s*connModalSide/);
  assert.match(save, /submittedPanel\s*=\s*connModalPanel\s*\|\|\s*_panelForSlot\(submittedSide\)/);
  assert.match(save, /fixedModalRequest\s*=\s*beginConnModalRequest\(null\)/);
  assert.match(save, /ownsFixedSubmission[\s\S]*?isConnModalRequestCurrent\(fixedModalRequest, submittedPanel, null\)/);
  assert.match(save, /await\s+api\([^;]+\);[\s\S]*?if\s*\(!ownsFixedSubmission\(\)\)[\s\S]*?return\s+false/);
  assert.doesNotMatch(save, /connCache\[connModalSide\]/);
  assert.match(save, /catch\s*\([^)]*\)[\s\S]*?ownsFixedSubmission\(\)[\s\S]*?errEl/);
});

test('re-rendering results refreshes statement blocks without detaching them', () => {
  const html = readHtml();
  const all = html.slice(html.indexOf('function rerenderAllResults(side)'), html.indexOf('function _looksLikeTSV('));
  const render = html.slice(html.indexOf('function renderResults(containerId'), html.indexOf('function fmtCell('));

  // Re-rendering the outer container replaces its innerHTML and detaches the
  // per-statement blocks, so refreshing those must not follow it.
  assert.match(all, /const stmtKeys = keys\.filter\(k => k !== mainId\)/);
  assert.match(all, /\(stmtKeys\.length \? stmtKeys : keys\)\.forEach/);
  // Defence in depth: never dereference a container that has been replaced.
  assert.match(render, /if \(!el\) \{ delete virtState\[containerId\]; return; \}/);
  assert.match(render, /if \(!el\)[\s\S]*?el\.removeEventListener/);
});

test('comparison snapshots are bounded so a long session cannot grow forever', () => {
  const html = readHtml();
  const capture = html.slice(html.indexOf('function captureResultSnapshot('), html.indexOf('// ── Query Tabs'));

  assert.match(html, /const SNAPSHOT_LIMIT = \d+/);
  assert.match(capture, /compareSnapshots\.length > SNAPSHOT_LIMIT/);
  assert.match(capture, /compareSnapshots\.splice\(0, compareSnapshots\.length - SNAPSHOT_LIMIT\)/);
  // Dropping ids must stay safe for anything still pointing at them.
  const resolve = html.slice(html.indexOf('function resolveSource(slot)'), html.indexOf('function _cmpSideLabel('));
  assert.match(resolve, /sn \? \{[\s\S]*?\} : null/);
});

test('the snippets popover closes from one shared listener, not one per open', () => {
  const html = readHtml();
  const toggle = html.slice(html.indexOf('function toggleSnippets(side, e)'), html.indexOf('// ── Paste as VALUES'));

  // The old per-open handler removed itself only if a click reached document,
  // which the toggle button's stopPropagation() prevented — so opens leaked.
  assert.doesNotMatch(toggle, /document\.addEventListener\('click', function handler/);
  assert.doesNotMatch(toggle, /removeEventListener/);
  assert.match(toggle, /document\.addEventListener\('click'[\s\S]*?snippets-popover\.open[\s\S]*?p\.contains\(e\.target\)/);
});

test('find-in-results is debounced and cancels pending work when cleared', () => {
  const html = readHtml();
  const clear = html.slice(html.indexOf('function clearGlobalFilter(side)'), html.indexOf('// ── Row counts'));

  assert.equal(count(html, /oninput="applyGlobalFilter\(/g), 0, 'no input filters undebounced');
  assert.equal(count(html, /oninput="scheduleGlobalFilter\(/g), 3, 'all three find inputs debounced');
  assert.match(html, /function scheduleGlobalFilter\(side, q\)[\s\S]*?clearTimeout\(_globalFilterTimer\[side\]\)[\s\S]*?setTimeout\(\(\) => applyGlobalFilter\(side, q\), \d+\)/);
  assert.match(clear, /clearTimeout\(_globalFilterTimer\[side\]\)[\s\S]*?applyGlobalFilter\(side, ''\)/);
});

test('the multi-pane Workspace view is gone and its controls go with it', () => {
  const html = readHtml();
  const header = html.match(/<header\b[\s\S]*?<\/header>/i)?.[0] || '';
  const selector = html.match(/<div class="mode-selector"[\s\S]*?<\/div>/i)?.[0] || '';

  for (const id of ['modeBothBtn', 'addPanelBtn', 'workspaceRunBtn', 'swapPanelsBtn', 'syncScrollBtn', 'workspaceBar', 'closeExtraPanesBtn']) {
    assert.equal(count(html, new RegExp(`id=["']${id}["']`, 'gi')), 0, `${id} is removed`);
  }
  assert.equal(count(selector, /<button/g), 2, 'exactly SQL Server and PostgreSQL remain');
  assert.doesNotMatch(header, />\s*Workspace\s*</);
  assert.doesNotMatch(html, /setMode\('both'\)"/);
});

test('code that survived the Workspace removal never dereferences a removed element', () => {
  const html = readHtml();
  const setMode = html.slice(html.indexOf('function setMode(mode)'), html.indexOf('function swapPanels()'));
  const syncScroll = html.slice(html.indexOf('function toggleSyncScroll()'), html.indexOf('function toggleSyncScroll()') + 400);

  // setMode ran on every boot and threw on the deleted modeBothBtn, which killed
  // the rest of DOMContentLoaded: no /api/status, no databases, no pollStatus.
  assert.doesNotMatch(setMode, /modeBothBtn/);
  assert.match(setMode, /\['modeMsBtn','modePgBtn'\]\.forEach/);
  assert.match(setMode, /const button = document\.getElementById\(id\);\s*\r?\n\s*if \(!button\) return;/);
  assert.match(syncScroll, /if \(!btn\) return;/);
  // Nothing may reference the removed id at all, in markup, script, or CSS.
  assert.equal(count(html, /modeBothBtn/g), 0);
});

test('the clients panel and its count are reachable from every view', () => {
  const html = readHtml();
  const poll = html.slice(html.indexOf('async function pollStatus()'), html.indexOf('function closeClientsPanel()'));
  const header = html.match(/<header\b[\s\S]*?<\/header>/i)?.[0] || '';
  const main = html.slice(html.indexOf('<main id="appMain"'), html.indexOf('id="pgPanel"'));

  // Both used to live inside pgPanel, so SQL Server view hid the online-client
  // count entirely and the panel could not be opened at all.
  assert.match(header, /id="headerPgClients"[^>]*onclick="toggleClientsPanel\(\)"/);
  assert.match(main, /id="clientsPanel"/, 'clients panel is a child of main, not pgPanel');
  assert.ok(html.indexOf('id="clientsPanel"') < html.indexOf('id="pgPanel"'), 'clients panel is outside pgPanel');
  assert.match(html, /<main id="appMain"[^>]*position:relative/);
  assert.match(poll, /const hdrEl = document\.getElementById\('headerPgClients'\)/);
  assert.match(poll, /hdrEl\.textContent = clientsText/);
});

test('a stored Workspace mode is coerced rather than honoured at boot', () => {
  const html = readHtml();
  const initStart = html.indexOf("window.addEventListener('DOMContentLoaded', async () => {");
  const init = html.slice(initStart, html.indexOf('// ── Table browser', initStart));

  assert.match(init, /storedMode\s*===\s*'ms'\s*\|\|\s*storedMode\s*===\s*'pg'\s*\?\s*storedMode\s*:\s*'ms'/);
  assert.doesNotMatch(init, /localStorage\.getItem\('lastMode'\)\s*\|\|\s*'both'/);
  assert.doesNotMatch(init, /panelsSwapped/);
});

test('stored panes are not silently reconnected now that they cannot be shown', () => {
  const html = readHtml();
  const restore = html.slice(html.indexOf('async function restorePanelLayout()'), html.indexOf('function dynamicProfile(side)'));

  // Restoring them would hold pooled connections for panes nobody can see or close.
  assert.doesNotMatch(restore, /connectDynamicPanel/);
  assert.doesNotMatch(restore, /addPanel\(/);
  assert.match(restore, /setActivePanel\(activePanelId\)/);
});

test('profiles are renamable by double-click, with the name kept unique', () => {
  const html = readHtml();
  const rename = html.slice(html.indexOf('function renameProfile(engine, oldName)'), html.indexOf('function deletePgProfile('));

  for (const engine of ['ms', 'pg']) {
    assert.match(html, new RegExp(`ondblclick="renameProfile\\('${engine}', this\\.dataset\\.profile\\)"`));
  }
  assert.match(html, /Double-click to rename · Right-click to delete/);
  assert.match(rename, /const name = input\.trim\(\)/);
  assert.match(rename, /if \(!name\)/);
  assert.match(rename, /PROFILE_NAME_MAX/);
  assert.match(rename, /p\.name\.toLowerCase\(\) === name\.toLowerCase\(\)/);
  // Rename carries the password and every other field; only `name` changes.
  assert.match(rename, /\{ \.\.\.p, name \}/);
  // Renaming a profile whose connect is still in flight must still adopt the new
  // name — the switch's own post-await guard declines to set the stale old one.
  assert.match(rename, /const switching = _profileSwitchInFlight === engine \+ ':' \+ oldName/);
  assert.match(rename, /activeMsProfile === oldName \|\| switching\)\) activeMsProfile = name/);
  assert.match(rename, /activePgProfile === oldName \|\| switching\)\) activePgProfile = name/);
  assert.match(rename, /panel\.profileName === oldName\) panel\.profileName = name/);
});

test('a double-click does not fire two connects or race the rename it triggers', () => {
  const html = readHtml();
  const ms = html.slice(html.indexOf('async function switchMsProfile(name)'), html.indexOf('function deleteMsProfile('));
  const pg = html.slice(html.indexOf('async function switchPgProfile(name)'), html.indexOf('function deletePgProfile('));

  assert.match(html, /let _profileSwitchInFlight = null/);
  for (const [engine, source] of [['ms', ms], ['pg', pg]]) {
    const active = engine === 'ms' ? 'activeMsProfile' : 'activePgProfile';
    const load = engine === 'ms' ? 'loadMsProfiles' : 'loadPgProfiles';
    assert.match(source, new RegExp(`if \\(${active} === name \\|\\| _profileSwitchInFlight === '${engine}:' \\+ name\\) return`));
    assert.match(source, new RegExp(`_profileSwitchInFlight = '${engine}:' \\+ name`));
    // A rename landing mid-connect must not resurrect the old name.
    assert.match(source, new RegExp(`if \\(${load}\\(\\)\\.some\\(p => p\\.name === name\\)\\) ${active} = name`));
    assert.match(source, /finally \{\s*_profileSwitchInFlight = null/);
  }
});

test('the clients panel is hidden by class, so visibility is never read from inline style', () => {
  const html = readHtml();
  const toggle = html.slice(html.indexOf('function toggleClientsPanel()'), html.indexOf('function renderClientsTable()'));

  assert.match(html, /\.clients-panel\s*\{[^}]*display:\s*none/);
  assert.match(html, /\.clients-panel\.visible\s*\{\s*display:\s*flex/);
  assert.match(toggle, /classList\.contains\(['"]visible['"]\)/);
  assert.doesNotMatch(toggle, /\.style\.display/);
});

test('the status poll skips renderClientsTable while the panel is closed', () => {
  const html = readHtml();
  const poll = html.slice(html.indexOf('async function pollStatus()'), html.indexOf('function toggleClientsPanel()'));
  const once = html.slice(html.indexOf('async function pollStatusOnce()'), html.indexOf('async function disconnectPg()'));

  // `clientsPanel.style.display` is only ever '' — the panel is hidden by a CSS
  // class — so an inline-style guard never blocks and the poll rebuilds a
  // multi-thousand-node table into a display:none panel every 5 seconds.
  for (const source of [poll, once]) {
    assert.doesNotMatch(source, /clientsPanel['"]\)\.style\.display/);
    assert.match(source, /clientsOpen\s*=\s*!!document\.getElementById\('clientsPanel'\)\?\.classList\.contains\('visible'\)/);
    assert.match(source, /if\s*\(clientsOpen\)\s*renderClientsTable\(\)/);
  }
});

test('the clients row list is fetched only while the panel is open', () => {
  const html = readHtml();
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const poll = html.slice(html.indexOf('async function pollStatus()'), html.indexOf('function toggleClientsPanel()'));
  const toggle = html.slice(html.indexOf('function toggleClientsPanel()'), html.indexOf('function renderClientsTable()'));
  const status = server.slice(server.indexOf('const wantClientRows'), server.indexOf('const msPools = {}'));

  assert.match(poll, /api\('\/api\/status'\s*\+\s*\(clientsOpen\s*\?\s*'\?clients=full'\s*:\s*''\)\)/);
  assert.match(toggle, /classList\.add\('visible'\)[\s\S]*?pollStatusOnce\(\)/);
  // Every close path drops the rendered rows instead of parking them hidden.
  const close = html.slice(html.indexOf('function closeClientsPanel()'), html.indexOf('function toggleClientsPanel()'));
  assert.match(close, /clientsTable'\)\.innerHTML\s*=\s*''/);
  assert.equal(count(html, /classList\.remove\('visible', 'expanded'\)/g), 1, 'a single close path');
  assert.match(toggle, /if\s*\(isOpen\)\s*\{\s*closeClientsPanel\(\);/);
  assert.match(html, /async function disconnectPg\(\)[\s\S]*?closeClientsPanel\(\)/);
  assert.match(status, /req\.query\.clients\s*===\s*'full'/);
  // The count is always needed for the header; only the aggregate is opt-in.
  assert.match(status, /if\s*\(!wantClientRows\)[\s\S]*?SELECT count\(\*\)::int AS n FROM pg_stat_activity/);
  assert.match(status, /rows:\s*null/);
  assert.match(status, /else\s*\{[\s\S]*?json_agg[\s\S]*?rdnsLookup/);
});

test('Tab in the editor stays in the editor and cannot collapse the results pane', () => {
  const html = readHtml();

  // getSearchCursor comes from the searchcursor addon, which is not loaded. A
  // call in the Tab path threw, so the browser moved focus onto the editor
  // divider and the next End/ArrowDown resized the editor over the results.
  if (!/\/addon\/search\/searchcursor/.test(html)) {
    assert.doesNotMatch(html, /\.getSearchCursor\(/);
  }
  // Even at the 1200px keyboard max (persisted in localStorage), the editor
  // must shrink before the results pane drops below its 80px minimum.
  assert.match(html, /\.cm-editor-wrap \{\s*flex-shrink: 1;/);
  assert.match(html, /\.editor-area > \.results-area \{ min-height: 80px; \}/);
});
