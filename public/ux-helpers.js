(function attachSQLConnectUX(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.SQLConnectUX = api;
  }
}(typeof window !== 'undefined' ? window : null, function createSQLConnectUX() {
  const WORKSPACE_VERSION = 1;
  const WORKSPACE_CATEGORIES = [
    'msProfiles', 'pgProfiles', 'savedQueries', 'sqlSnippets', 'queryTabs', 'queryHistory',
    'theme', 'paneLayout', 'preferences',
  ];
  const WORKSPACE_CATEGORY_SET = new Set(WORKSPACE_CATEGORIES);
  const PROFILE_KEYS = ['name', 'type', 'server', 'host', 'port', 'user', 'readOnly'];
  const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  const SECRET_KEY_SUFFIXES = [
    'password', 'passwd', 'pwd', 'connectionstring', 'connstr', 'token', 'secret',
    'apikey', 'credential', 'credentials', 'authorization', 'privatekey', 'accesskey',
  ];
  const OMIT_VALUE = Symbol('omit workspace value');
  const ENVIRONMENT_FIELDS = ['name', 'server', 'host', 'profileName', 'database'];
  const PRODUCTION_MARKER = /(?:^|[^a-z0-9])(?:prod|production)(?=$|[^a-z0-9])/i;

  function isUnsafeKey(key) {
    return UNSAFE_KEYS.has(String(key));
  }

  function isSecretKey(key) {
    const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
    return SECRET_KEY_SUFFIXES.some((suffix) => (
      normalized === suffix || normalized.endsWith(suffix)
    ));
  }

  function isSecretBearingConnectionString(value) {
    return /\b(?:password|passwd|pwd|token|secret|api[ _-]?key)\s*=/i.test(value)
      || /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s:@]+:[^/?#\s@]+@/i.test(value);
  }

  function cloneWorkspaceValue(value, removeSecrets) {
    if (value === undefined) return OMIT_VALUE;
    if (typeof value === 'string') {
      return removeSecrets && isSecretBearingConnectionString(value) ? OMIT_VALUE : value;
    }
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return value.reduce((items, item) => {
        const cloned = cloneWorkspaceValue(item, removeSecrets);
        if (cloned !== OMIT_VALUE) items.push(cloned);
        return items;
      }, []);
    }

    const cloned = {};
    Object.keys(value).forEach((key) => {
      if (isUnsafeKey(key) || (removeSecrets && isSecretKey(key))) return;
      const child = cloneWorkspaceValue(value[key], removeSecrets);
      if (child !== OMIT_VALUE) cloned[key] = child;
    });
    return cloned;
  }

  function classifyEnvironment(meta) {
    if (!meta || typeof meta !== 'object') return 'standard';

    return ENVIRONMENT_FIELDS.some((field) => (
      typeof meta[field] === 'string' && PRODUCTION_MARKER.test(meta[field])
    )) ? 'production' : 'standard';
  }

  function sanitizeProfile(profile) {
    const sanitized = {};
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return sanitized;

    ['name', 'server', 'host', 'user'].forEach((key) => {
      if (typeof profile[key] !== 'string') return;
      const value = profile[key].replace(/[<>'"]/g, '').trim().slice(0, 120);
      if (value && !isSecretBearingConnectionString(value)) sanitized[key] = value;
    });
    if (typeof profile.type === 'string' && /^(mssql|postgres|postgresql|ms|pg)$/i.test(profile.type)) sanitized.type = profile.type.toLowerCase();
    const port = typeof profile.port === 'number' ? profile.port : (/^\d+$/.test(String(profile.port || '')) ? Number(profile.port) : NaN);
    if (Number.isSafeInteger(port) && port > 0 && port <= 65535) sanitized.port = port;
    if (typeof profile.readOnly === 'boolean') sanitized.readOnly = profile.readOnly;
    else if (typeof profile.readOnly === 'string' && /^(true|yes)$/i.test(profile.readOnly)) sanitized.readOnly = true;
    return sanitized;
  }

  function sanitizeProfiles(profiles) {
    if (Array.isArray(profiles)) return profiles.map(sanitizeProfile);
    if (profiles && typeof profiles === 'object') return sanitizeProfile(profiles);
    return cloneWorkspaceValue(profiles, true);
  }

  function safeText(value, limit) {
    return typeof value === 'string' ? value.trim().slice(0, limit) : '';
  }

  function isSafeRecordId(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function isSafePaneKey(value) {
    return value === 'ms' || value === 'pg' || /^c\d+$/.test(value);
  }

  function sanitizeQueryRecords(records, kind) {
    if (!Array.isArray(records)) return [];
    const ids = new Set(); const result = [];
    records.forEach((record) => {
      if (!record || typeof record !== 'object' || Array.isArray(record) || !isSafeRecordId(record.id) || ids.has(record.id)) return;
      const name = safeText(record.name, 120);
      const text = typeof record[kind === 'saved' ? 'sql' : 'text'] === 'string'
        ? record[kind === 'saved' ? 'sql' : 'text'].slice(0, 100000) : '';
      if (!name || !text) return;
      const clean = kind === 'saved' ? { id: record.id, name, sql: text } : { id: record.id, name, text };
      ['engine', 'database'].forEach((key) => { const value = safeText(record[key], 120); if (value) clean[key] = value; });
      if (typeof record.ts === 'string') clean.ts = record.ts.slice(0, 80);
      ids.add(record.id); result.push(clean);
    });
    return result;
  }

  function sanitizeQueryTabs(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return OMIT_VALUE;
    const output = {};
    Object.keys(value).filter(isSafePaneKey).forEach((pane) => {
      const state = value[pane]; if (!state || typeof state !== 'object' || !Array.isArray(state.tabs)) return;
      const ids = new Set(); const tabs = [];
      state.tabs.forEach((tab) => {
        if (!tab || typeof tab !== 'object' || Array.isArray(tab) || !isSafeRecordId(tab.id) || ids.has(tab.id)) return;
        const name = safeText(tab.name, 120); const content = typeof tab.content === 'string' ? tab.content.slice(0, 100000) : '';
        if (!name) return;
        const clean = { id: tab.id, name, content };
        const db = safeText(tab.db, 120); if (db) clean.db = db;
        ids.add(tab.id); tabs.push(clean);
      });
      if (!tabs.length) return;
      output[pane] = { tabs, activeId: ids.has(state.activeId) ? state.activeId : tabs[0].id };
    });
    return output;
  }

  function sanitizeQueryHistory(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return OMIT_VALUE;
    const output = {};
    Object.keys(value).filter(isSafePaneKey).forEach((pane) => {
      if (!Array.isArray(value[pane])) return;
      output[pane] = value[pane].reduce((items, entry) => {
        const query = entry && typeof entry.query === 'string' ? entry.query.slice(0, 100000) : '';
        if (!query) return items;
        const clean = { query, ts: Number.isSafeInteger(entry.ts) && entry.ts > 0 ? entry.ts : Date.now() };
        const db = safeText(entry.db, 120); if (db) clean.db = db;
        ['rows', 'ms'].forEach((key) => { if (Number.isFinite(entry[key]) && entry[key] >= 0) clean[key] = Math.round(entry[key]); });
        items.push(clean); return items;
      }, []).slice(0, 100);
    });
    return output;
  }

  function mergeProfilesPreservingSecrets(current, incoming) {
    const passwords = new Map((Array.isArray(current) ? current : []).filter(profile => profile && typeof profile.name === 'string')
      .map(profile => [profile.name.trim(), profile.password]));
    return (Array.isArray(incoming) ? incoming : []).map(sanitizeProfile).filter(profile => profile.name).map((profile) => {
      const password = passwords.get(profile.name); return typeof password === 'string' && password ? { ...profile, password } : profile;
    });
  }

  function applyWorkspaceOperations(operations) {
    const applied = [];
    try { (Array.isArray(operations) ? operations : []).forEach((operation) => { operation.apply(); applied.push(operation); }); return { ok: true, rollbackFailed: false }; }
    catch (error) { let rollbackFailed = false; applied.reverse().forEach((operation) => { try { operation.rollback(); } catch { rollbackFailed = true; } }); return { ok: false, error, rollbackFailed }; }
  }

  function sanitizeWorkspaceCategory(category, value) {
    if (!WORKSPACE_CATEGORY_SET.has(category)) return OMIT_VALUE;
    if (category === 'msProfiles' || category === 'pgProfiles') {
      return Array.isArray(value) ? value.map(sanitizeProfile) : OMIT_VALUE;
    }
    if (category === 'savedQueries') return Array.isArray(value) ? sanitizeQueryRecords(value, 'saved') : OMIT_VALUE;
    if (category === 'sqlSnippets') return Array.isArray(value) ? sanitizeQueryRecords(value, 'snippet') : OMIT_VALUE;
    if (category === 'queryTabs') return sanitizeQueryTabs(value);
    if (category === 'queryHistory') return sanitizeQueryHistory(value);
    if (category === 'preferences') {
      return value && typeof value === 'object' && !Array.isArray(value)
        ? cloneWorkspaceValue(value, true) : OMIT_VALUE;
    }
    if (category === 'theme') return ['dark', 'light', 'system'].includes(value) ? value : OMIT_VALUE;
    if (category === 'paneLayout') return Array.isArray(value) ? sanitizePanelLayout(value) : OMIT_VALUE;
    return OMIT_VALUE;
  }

  function buildWorkspacePayload(data, exportedAt) {
    const sanitizedData = {};
    const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {};

    WORKSPACE_CATEGORIES.forEach((key) => {
      const value = sanitizeWorkspaceCategory(key, source[key]);
      if (value !== OMIT_VALUE) sanitizedData[key] = value;
    });

    return {
      version: WORKSPACE_VERSION,
      exportedAt: exportedAt || new Date().toISOString(),
      data: sanitizedData,
    };
  }

  function validateWorkspacePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
      return { ok: false, error: 'Invalid SQLConnect workspace file' };
    }
    if (payload.version !== WORKSPACE_VERSION) {
      return { ok: false, error: `Unsupported workspace version: ${payload.version}` };
    }
    const value = buildWorkspacePayload(payload.data, payload.exportedAt).data;
    if (!Object.keys(value).length) {
      return { ok: false, error: 'Workspace file contains no supported data' };
    }
    const sanitized = { version: WORKSPACE_VERSION, data: value };
    if (typeof payload.exportedAt === 'string') sanitized.exportedAt = payload.exportedAt;
    return { ok: true, value: sanitized };
  }

  function mergeWorkspaceData(current, incoming, categories) {
    const result = {};
    const currentData = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    const incomingData = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};

    WORKSPACE_CATEGORIES.forEach((key) => {
      const value = sanitizeWorkspaceCategory(key, currentData[key]);
      if (value !== OMIT_VALUE) result[key] = value;
    });
    (Array.isArray(categories) ? categories : []).forEach((key) => {
      const category = String(key);
      if (WORKSPACE_CATEGORY_SET.has(category) && Object.prototype.hasOwnProperty.call(incomingData, category)) {
        const value = sanitizeWorkspaceCategory(category, incomingData[category]);
        if (value !== OMIT_VALUE) result[category] = value;
      }
    });
    return result;
  }

  function pushRecovery(stack, item, limit) {
    const cap = limit === undefined ? 10 : limit;
    return [item, ...(Array.isArray(stack) ? stack : [])].slice(0, cap);
  }

  function chooseActivePanel(preferredId, visibleIds) {
    const visible = Array.isArray(visibleIds) ? visibleIds : [];
    if (visible.includes(preferredId)) return preferredId;
    return visible.length ? visible[0] : null;
  }

  function panelLayoutForMode(mode, savedRatio) {
    const normalizedMode = mode === 'ms' || mode === 'pg' ? mode : 'both';
    const parsed = savedRatio === null || savedRatio === '' ? NaN : Number(savedRatio);
    const ratio = Number.isFinite(parsed) ? Math.max(0.2, Math.min(0.8, parsed)) : 0.5;
    if (normalizedMode === 'ms') {
      return { mode: 'ms', msFlex: '1 1 100%', pgFlex: '', dividerVisible: false, ratio };
    }
    if (normalizedMode === 'pg') {
      return { mode: 'pg', msFlex: '', pgFlex: '1 1 100%', dividerVisible: false, ratio };
    }
    return {
      mode: 'both',
      msFlex: `${ratio} 1 0`,
      pgFlex: `${1 - ratio} 1 0`,
      dividerVisible: true,
      ratio,
    };
  }

  function workspacePaneRailState(dynamicIds, activeId) {
    const ids = [...new Set((Array.isArray(dynamicIds) ? dynamicIds : [])
      .filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))];
    const dynamicCount = ids.length;
    const paneCount = dynamicCount + 2;
    const active = activeId === 'ms' || activeId === 'pg' || ids.includes(activeId) ? activeId : 'ms';
    return {
      hasExtras: dynamicCount > 0,
      dynamicCount,
      paneCount,
      countLabel: dynamicCount ? `${paneCount} panes · ${dynamicCount} extra` : '2 panes',
      activeId: active,
      closeExtrasDisabled: dynamicCount === 0,
    };
  }

  function planDynamicPaneClose(panes) {
    const seen = new Set();
    const closableIds = [];
    const runningIds = [];
    let dirtyCount = 0;
    (Array.isArray(panes) ? panes : []).forEach((pane) => {
      if (!pane || typeof pane !== 'object' || typeof pane.id !== 'string') return;
      const id = pane.id.trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      if (pane.running) { runningIds.push(id); return; }
      closableIds.push(id);
      if (pane.dirty) dirtyCount++;
    });
    const paneCount = closableIds.length;
    let prompt = paneCount ? `Close ${paneCount} extra pane${paneCount === 1 ? '' : 's'}?` : '';
    if (dirtyCount) {
      prompt += ` ${dirtyCount} pane${dirtyCount === 1 ? '' : 's'} ${dirtyCount === 1 ? 'contains' : 'contain'} query text.`;
    }
    return { closableIds, runningIds, dirtyCount, prompt };
  }

  function sanitizePanelLayout(panels) {
    if (!Array.isArray(panels)) return [];
    const result = [];
    const seen = new Set();
    panels.forEach((panel) => {
      if (!panel || typeof panel !== 'object' || Array.isArray(panel)
        || Object.getPrototypeOf(panel) !== Object.prototype) return;
      if (Object.keys(panel).some(isUnsafeKey)) return;
      const id = typeof panel.id === 'string' ? panel.id.trim() : '';
      if (!/^c\d+$/.test(id) || seen.has(id) || (panel.engine !== 'ms' && panel.engine !== 'pg')) return;
      const clean = { id, engine: panel.engine };
      ['profileName', 'title'].forEach((key) => {
        if (typeof panel[key] === 'string') {
          const value = panel[key].trim();
          if (value) clean[key] = value.slice(0, 120);
        }
      });
      if (typeof panel.width === 'number' && Number.isFinite(panel.width)
        && panel.width >= 320 && panel.width <= 2400) clean.width = Math.round(panel.width);
      seen.add(id);
      result.push(clean);
    });
    return result;
  }

  return {
    WORKSPACE_VERSION,
    WORKSPACE_CATEGORIES,
    classifyEnvironment,
    sanitizeProfile,
    mergeProfilesPreservingSecrets,
    applyWorkspaceOperations,
    buildWorkspacePayload,
    validateWorkspacePayload,
    mergeWorkspaceData,
    pushRecovery,
    chooseActivePanel,
    panelLayoutForMode,
    workspacePaneRailState,
    planDynamicPaneClose,
    sanitizePanelLayout,
  };
}));
