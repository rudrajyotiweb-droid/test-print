// Minimal better-sqlite3-compatible API on top of sql.js (SQLite compiled to WebAssembly).
// No native build step, so it installs on any host. The database lives in memory and is
// written to disk (atomically) shortly after every change.
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';

const SQL = await initSqlJs();

// better-sqlite3 style: run({ id }) binds @id / :id / $id; run(a, b) binds ? positionally
function bindParams(args) {
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    const out = {};
    for (const [k, v] of Object.entries(args[0])) {
      const val = v === undefined ? null : v;
      out[`@${k}`] = val;
      out[`:${k}`] = val;
      out[`$${k}`] = val;
    }
    return out;
  }
  return args.map((v) => (v === undefined ? null : v));
}

export default class Database {
  constructor(file) {
    this.file = file;
    this.inTransaction = false;
    this.saveTimer = null;
    this.load();
    process.once('exit', () => this.flush());
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.once(sig, () => {
        this.flush();
        process.exit(0);
      });
    }
  }

  load() {
    const data = fs.existsSync(this.file) ? fs.readFileSync(this.file) : null;
    this.db = data ? new SQL.Database(data) : new SQL.Database();
    this.syncedMtime = data ? fs.statSync(this.file).mtimeMs : 0;
  }

  // Another process (e.g. `npm run seed`) may have written the file — reload before using it.
  refresh() {
    if (this.inTransaction || this.saveTimer) return;
    try {
      const mtime = fs.statSync(this.file).mtimeMs;
      if (mtime > this.syncedMtime) {
        this.db.close();
        this.load();
      }
    } catch {
      /* file not created yet */
    }
  }

  scheduleSave() {
    if (this.inTransaction) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 50);
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(this.db.export()));
    fs.renameSync(tmp, this.file);
    this.syncedMtime = fs.statSync(this.file).mtimeMs;
  }

  pragma(str) {
    // WAL / busy_timeout don't apply to an in-memory engine; keep foreign keys on.
    if (/^foreign_keys/i.test(str)) this.db.run(`PRAGMA ${str}`);
  }

  exec(sql) {
    this.refresh();
    this.db.exec(sql);
    this.scheduleSave();
    return this;
  }

  prepare(sql) {
    const self = this;
    const withStmt = (args, fn) => {
      self.refresh();
      const stmt = self.db.prepare(sql);
      try {
        if (args.length) stmt.bind(bindParams(args));
        return fn(stmt);
      } finally {
        stmt.free();
      }
    };
    return {
      get: (...args) => withStmt(args, (s) => (s.step() ? s.getAsObject() : undefined)),
      all: (...args) =>
        withStmt(args, (s) => {
          const rows = [];
          while (s.step()) rows.push(s.getAsObject());
          return rows;
        }),
      run: (...args) =>
        withStmt(args, (s) => {
          s.step();
          const changes = self.db.getRowsModified();
          self.scheduleSave();
          return { changes };
        }),
    };
  }

  transaction(fn) {
    return (...args) => {
      this.refresh();
      this.db.run('BEGIN');
      this.inTransaction = true;
      try {
        const result = fn(...args);
        this.db.run('COMMIT');
        return result;
      } catch (err) {
        this.db.run('ROLLBACK');
        throw err;
      } finally {
        this.inTransaction = false;
        this.scheduleSave();
      }
    };
  }

  close() {
    this.flush();
    this.db.close();
  }
}
