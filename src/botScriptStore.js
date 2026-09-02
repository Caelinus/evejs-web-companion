"use strict";

// D1 — the Bot Builder library store: platform-wide CRUD over a single
// web-repo-owned JSON file (data/bot-scripts.json), using the same atomic
// tmp+rename write as webAuth.js. This is WEB-APP data — it never touches eve.js's
// gamestore.sqlite or its stale data/*.json, keeping the thin-bridge boundary.
//
// ⚠ VALIDATION HERE IS ENVELOPE-LITE ON PURPOSE. The server is plain JS and
// cannot run the browser's TypeScript codec, so it only guards SIZE, OWNERSHIP,
// and the optimistic revision. The real gate is the browser decoding every doc
// on read (decode-on-read), and only the browser ever executes a script. Keying
// is GLOBAL, not per account: this is a single-operator local deployment, so the
// account a script was saved from is a login detail, not a tenancy boundary.
// Every script is visible to every account; `authorAccountID` is kept only so
// the UI can show who wrote it.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STORE_FILENAME = "bot-scripts.json";
const MAX_SCRIPTS_TOTAL = 200;
const MAX_DOC_BYTES = 49152; // 48 KB — the same ceiling the browser codec uses
const MAX_NAME_LEN = 60;

function createBotScriptStore(options) {
  const dataDir = options.dataDir;
  const now = options.now || (() => new Date().toISOString());
  const uuid = options.uuid || (() => crypto.randomUUID());
  const filePath = path.join(dataDir, STORE_FILENAME);

  function ensureDir() {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Normalizes old-shape records (per-account: `accountID`) into the new
  // global shape (`authorAccountID`) in memory. Never writes — a GET must
  // not have a side effect — so this must be idempotent: the normalized
  // shape only lands on disk the next time something calls writeAll().
  function normalize(data) {
    for (const record of Object.values(data.scripts)) {
      if (record.authorAccountID === undefined && record.accountID !== undefined) {
        record.authorAccountID = record.accountID;
        delete record.accountID;
      }
      if (record.authorName === undefined) {
        record.authorName = null;
      }
    }
    return data;
  }

  function readAll() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed.scripts === "object" && parsed.scripts !== null) {
        return normalize(parsed);
      }
      return { scripts: {} };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { scripts: {} };
      }
      throw error;
    }
  }

  function writeAll(data) {
    ensureDir();
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
  }

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function docBytes(doc) {
    return Buffer.byteLength(JSON.stringify(doc), "utf8");
  }

  function nameOf(doc) {
    if (doc && typeof doc.name === "string" && doc.name.trim().length > 0) {
      return doc.name.trim().slice(0, MAX_NAME_LEN);
    }
    return "Untitled bot";
  }

  // Same cap idiom as nameOf(), but blank/missing collapses to null rather
  // than a placeholder string — "no author name on file" is a different
  // thing from "Untitled bot".
  function authorNameOf(authorName) {
    if (typeof authorName === "string" && authorName.trim().length > 0) {
      return authorName.trim().slice(0, MAX_NAME_LEN);
    }
    return null;
  }

  function meta(record) {
    return {
      scriptID: record.scriptID,
      authorAccountID: record.authorAccountID,
      authorName: record.authorName,
      name: record.name,
      rev: record.rev,
      updatedAt: record.updatedAt,
      bytes: record.bytes,
    };
  }

  function guardDoc(doc) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw fail("BOTSCRIPT_INVALID", "That is not a bot script.");
    }
    const bytes = docBytes(doc);
    if (bytes > MAX_DOC_BYTES) {
      throw fail("BOTSCRIPT_TOO_BIG", "This script is too big to save.");
    }
    return bytes;
  }

  return {
    /** Metadata for every script in the deployment (no docs). */
    list() {
      const all = readAll();
      return Object.values(all.scripts).map(meta);
    },

    /** The full record, or null when it does not exist. */
    get(scriptID) {
      const record = readAll().scripts[String(scriptID)];
      return record || null;
    },

    /** Save a new script; returns { scriptID, rev }. Throws on quota or size. */
    create(authorAccountID, authorName, doc) {
      const author = Number(authorAccountID);
      const bytes = guardDoc(doc);
      const all = readAll();
      const total = Object.keys(all.scripts).length;
      if (total >= MAX_SCRIPTS_TOTAL) {
        throw fail("BOTSCRIPT_LIMIT_REACHED", "You have reached the limit of saved bots.");
      }
      const scriptID = uuid();
      const timestamp = now();
      all.scripts[scriptID] = {
        scriptID,
        authorAccountID: author,
        authorName: authorNameOf(authorName),
        rev: 1,
        name: nameOf(doc),
        bytes,
        createdAt: timestamp,
        updatedAt: timestamp,
        doc,
      };
      writeAll(all);
      return { scriptID, rev: 1 };
    },

    /** Update in place with optimistic concurrency; returns { rev }. */
    update(scriptID, doc, baseRev) {
      const bytes = guardDoc(doc);
      const all = readAll();
      const record = all.scripts[String(scriptID)];
      if (!record) {
        throw fail("BOTSCRIPT_NOT_FOUND", "That bot could not be found.");
      }
      if (Number(baseRev) !== record.rev) {
        throw fail(
          "SCRIPT_REV_CONFLICT",
          "This script was changed in another tab. Reload it, or save yours as a copy.",
        );
      }
      // authorAccountID / authorName are NOT touched here. The field records
      // who first saved the script, not who last edited it — an editor other
      // than the original author must not become the new "saved by".
      record.rev += 1;
      record.name = nameOf(doc);
      record.bytes = bytes;
      record.updatedAt = now();
      record.doc = doc;
      writeAll(all);
      return { rev: record.rev };
    },

    /** Delete a script; true when it existed. */
    remove(scriptID) {
      const all = readAll();
      const record = all.scripts[String(scriptID)];
      if (!record) {
        return false;
      }
      delete all.scripts[String(scriptID)];
      writeAll(all);
      return true;
    },
  };
}

module.exports = {
  createBotScriptStore,
  MAX_SCRIPTS_TOTAL,
  MAX_DOC_BYTES,
  MAX_NAME_LEN,
  STORE_FILENAME,
};
