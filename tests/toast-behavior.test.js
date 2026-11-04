const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const start = html.indexOf('function showToast(');
const end = html.indexOf('// ── Utilities', start);
const showToastSource = html.slice(start, end);

function runToast({ persist = false, action = null } = {}) {
  const container = { children: [], appendChild(child) { this.children.push(child); } };
  const timers = [];
  const document = {
    getElementById(id) { return id === 'toast-container' ? container : null; },
    createElement(tag) {
      return {
        tag, children: [], removed: false,
        setAttribute() {},
        appendChild(child) { this.children.push(child); },
        remove() { this.removed = true; },
      };
    },
  };
  const context = {
    document,
    esc: value => String(value),
    setTimeout(callback, delay) { timers.push({ callback, delay }); },
  };
  vm.runInNewContext(`${showToastSource}\nshowToast('Tab closed', 'info', ${persist}, action);`, {
    ...context,
    action,
  });
  return { toast: container.children[0], timers };
}

test('a non-persistent toast with an action auto-dismisses after three seconds', () => {
  const { toast, timers } = runToast({ action: { label: 'Reopen', run() {} } });

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 3000);
  assert.equal(toast.removed, false);
  timers[0].callback();
  assert.equal(toast.removed, true);
});

test('a persistent toast with an action remains until dismissed by the user', () => {
  const { timers } = runToast({ persist: true, action: { label: 'Retry', run() {} } });

  assert.equal(timers.length, 0);
});
