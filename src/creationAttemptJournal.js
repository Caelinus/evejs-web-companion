"use strict";

// Durable, credential-free creation fences. A process may die after sending a
// create but before observing the result. Its next process must reread EveJS,
// never infer from an absent local promise that a second send is safe.
const fs = require("fs");
const path = require("path");

function createCreationAttemptJournal({ filePath = null } = {}) {
  let entries = {};
  if (filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!parsed || parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object" ||
          Array.isArray(parsed.entries)) throw new Error("Invalid creation attempt journal");
      entries = parsed.entries;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  function save(next) {
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ version: 1, entries: next }, null, 2), "utf8");
      fs.renameSync(tempPath, filePath);
    }
    entries = next;
  }
  return {
    get(key) { return Object.hasOwn(entries, key) ? entries[key] : null; },
    mark(key, value) {
      if (Object.hasOwn(entries, key)) return false;
      save({ ...entries, [key]: value });
      return true;
    },
    clear(key) {
      if (!Object.hasOwn(entries, key)) return;
      const next = { ...entries };
      delete next[key];
      save(next);
    },
  };
}

module.exports = { createCreationAttemptJournal };
