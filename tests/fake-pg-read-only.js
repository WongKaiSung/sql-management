const Module = require('node:module');
const { EventEmitter } = require('node:events');

class FakePgClient {
  constructor() {
    this.processID = 4242;
    this.readOnly = false;
  }

  async query(sql) {
    if (sql === 'BEGIN READ ONLY') this.readOnly = true;
    if (sql === 'BEGIN') this.readOnly = false;
    if (/^ROLLBACK|^COMMIT/.test(sql)) this.readOnly = false;
    if (this.readOnly && /\bnextval\s*\(/i.test(sql)) {
      const error = new Error('cannot execute nextval() in a read-only transaction');
      error.code = '25006';
      throw error;
    }
    return { fields: [], rows: [], rowCount: 0 };
  }

  release() {}
}

// pg.Pool is an EventEmitter, and server.js attaches a pool 'error' listener.
class FakePgPool extends EventEmitter {
  constructor() {
    super();
    this.totalCount = 0;
    this.idleCount = 0;
    this.waitingCount = 0;
  }

  async query() {
    return { fields: [], rows: [], rowCount: 0 };
  }

  async connect() {
    return new FakePgClient();
  }

  async end() {}
}

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'pg') return { Pool: FakePgPool };
  return originalLoad.call(this, request, parent, isMain);
};
