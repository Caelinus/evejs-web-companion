"use strict";

// The companion's OWN database: data/companion.sqlite, beside bot-scripts.json
// and the login secret, on the evejs-web-poc-data volume in docker mode.
//
// ⚠ NEVER eve.js's gamestore.sqlite. That file belongs to the game server: it
// is mounted read-only in docker mode, eve.js migrates it on its own schedule,
// and a world reset would take anything we put there with it. Web-app data
// lives here, and only here.
//
// ⚠ OPENED ON FIRST USE, NOT AT BOOT. createApp() runs in dozens of tests with
// a read-only or throwaway data dir; opening eagerly would create (or fail to
// create) a database file in every one of them. The first route that needs a
// table pays for the open.
//
// MIGRATIONS are an append-only list. `PRAGMA user_version` records how many
// have run; on open, every step past it runs in one transaction, so a crash
// mid-upgrade leaves the file at the old version rather than half-migrated.
// Never edit or reorder a shipped step -- add a new one.

const fs = require("fs");
const path = require("path");

const DB_FILENAME = "companion.sqlite";

const MIGRATIONS = Object.freeze([
  // 1 -- saved Planetary Industry plans (R108). Intent only: what to make and
  // how many. The planner re-derives everything else from live stock, so no
  // computed result is ever stored here to go stale.
  `CREATE TABLE pi_plans (
     id         TEXT PRIMARY KEY,
     type_id    INTEGER NOT NULL CHECK (type_id > 0),
     quantity   INTEGER NOT NULL CHECK (quantity > 0),
     note       TEXT NOT NULL DEFAULT '',
     status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done')),
     rev        INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  // 2 -- saved Industry Manager plans (R109). Intent only, as for PI: what to
  // build, how many runs, and the player's choices (what to buy instead of
  // build, job splits, assumed blueprint terms) as canonical JSON. Stock,
  // shortfalls and verdicts are re-derived on every read.
  `CREATE TABLE industry_plans (
     id              TEXT PRIMARY KEY,
     product_type_id INTEGER NOT NULL CHECK (product_type_id > 0),
     runs            INTEGER NOT NULL CHECK (runs > 0),
     choices         TEXT NOT NULL DEFAULT '{}',
     note            TEXT NOT NULL DEFAULT '',
     status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done')),
     rev             INTEGER NOT NULL DEFAULT 1,
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL
   )`,
]);

/** Bring an open database up to the latest schema. Returns the version reached. */
function migrate(db, migrations = MIGRATIONS) {
  const current = db.pragma("user_version", { simple: true });
  if (current > migrations.length) {
    const error = new Error(
      `${DB_FILENAME} is at schema ${current}, newer than this build knows (${migrations.length}).`,
    );
    error.code = "COMPANION_DB_TOO_NEW";
    throw error;
  }
  if (current === migrations.length) return current;
  db.transaction(() => {
    for (let step = current; step < migrations.length; step += 1) {
      db.exec(migrations[step]);
    }
    db.pragma(`user_version = ${migrations.length}`);
  })();
  return migrations.length;
}

/**
 * Open (creating when missing) and migrate. `filename` may be ":memory:" for
 * tests; otherwise the file is `dataDir/companion.sqlite`.
 */
function openCompanionDb({ dataDir, filename } = {}) {
  // Required here, not at the top: a checkout without the native module can
  // still boot every route that never touches the database.
  const Database = require("better-sqlite3");
  let target = filename;
  if (!target) {
    fs.mkdirSync(dataDir, { recursive: true });
    target = path.join(dataDir, DB_FILENAME);
  }
  const db = new Database(target);
  if (target !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** A handle that opens the database on its first `get()`, then reuses it. */
function lazyCompanionDb(options) {
  let db = null;
  return {
    get() {
      if (db === null) db = openCompanionDb(options);
      return db;
    },
    close() {
      if (db !== null) db.close();
      db = null;
    },
  };
}

module.exports = { DB_FILENAME, MIGRATIONS, migrate, openCompanionDb, lazyCompanionDb };
