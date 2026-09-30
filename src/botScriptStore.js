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
const MAX_CATEGORIES = 50;
const MAX_CATEGORY_NAME_LEN = 40;

// ─── Starter bots ────────────────────────────────────────────────────────────
//
// src/starterBots.json holds six ready-made bots, reborn from the Bot Builder's
// old client-side block snippets (deleted when they moved here, so that JSON is
// now their only source — do not go looking for the module). They ride the
// exact same envelope-lite contract as everything else in this file: this
// module never proves the JSON decodes as a valid BotScript, it only inserts
// it byte-for-byte. The real gate is still the browser decoding every doc on
// read (see the file header above) — a separate web-side test decodes
// starterBots.json through the real codec.
const STARTER_BOTS_PATH = path.join(__dirname, "starterBots.json");
// Bumping this forces a re-seed pass (new/changed starters get inserted by id;
// existing records, including ones the player deleted, are still never
// resurrected — see seedStarterBots() below).
const STARTER_SEED_VERSION = 1;
const STARTER_AUTHOR_NAME = "Shipped with the app";

let starterBotsCache = null;
function loadStarterBots() {
  if (starterBotsCache === null) {
    const parsed = JSON.parse(fs.readFileSync(STARTER_BOTS_PATH, "utf8"));
    starterBotsCache = Array.isArray(parsed.bots) ? parsed.bots : [];
  }
  return starterBotsCache;
}

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
    // Categories arrived after the library did: a file without them has none,
    // and a bot pointing at a category that is gone is simply uncategorized.
    if (!Array.isArray(data.categories)) {
      data.categories = [];
    }
    const known = new Set(data.categories.map((category) => category.categoryID));
    for (const record of Object.values(data.scripts)) {
      if (typeof record.categoryID !== "string" || !known.has(record.categoryID)) {
        record.categoryID = null;
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
      return { scripts: {}, categories: [] };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { scripts: {}, categories: [] };
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
      categoryID: record.categoryID,
    };
  }

  function categoryNameOf(name) {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (trimmed.length === 0) {
      throw fail("BOTCATEGORY_INVALID", "Give the category a name.");
    }
    return trimmed.slice(0, MAX_CATEGORY_NAME_LEN);
  }

  function guardUniqueName(all, name, exceptID) {
    const lower = name.toLowerCase();
    const clash = all.categories.find(
      (category) => category.categoryID !== exceptID && category.name.toLowerCase() === lower,
    );
    if (clash) {
      throw fail("BOTCATEGORY_NAME_TAKEN", `There is already a category called "${clash.name}".`);
    }
  }

  function findCategory(all, categoryID) {
    const category = all.categories.find((row) => row.categoryID === String(categoryID));
    if (!category) {
      throw fail("BOTCATEGORY_NOT_FOUND", "That category could not be found.");
    }
    return category;
  }

  // `undefined` means "the caller did not say" (keep what is there); `null`
  // means Uncategorized; anything else must name a category that exists.
  function resolveCategoryID(all, categoryID) {
    if (categoryID === undefined || categoryID === null) {
      return categoryID;
    }
    return findCategory(all, categoryID).categoryID;
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

    /**
     * Save a new script; returns { scriptID, rev }. Throws on quota or size.
     * `categoryID` is optional: absent or null files it as Uncategorized.
     */
    create(authorAccountID, authorName, doc, categoryID) {
      const author = Number(authorAccountID);
      const bytes = guardDoc(doc);
      const all = readAll();
      const total = Object.keys(all.scripts).length;
      if (total >= MAX_SCRIPTS_TOTAL) {
        throw fail("BOTSCRIPT_LIMIT_REACHED", "You have reached the limit of saved bots.");
      }
      const category = resolveCategoryID(all, categoryID) ?? null;
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
        categoryID: category,
        doc,
      };
      writeAll(all);
      return { scriptID, rev: 1 };
    },

    /**
     * Update in place with optimistic concurrency; returns { rev }.
     * `categoryID` undefined keeps the bot where it is; null uncategorizes it.
     */
    update(scriptID, doc, baseRev, categoryID) {
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
      const category = resolveCategoryID(all, categoryID);
      if (category !== undefined) {
        record.categoryID = category;
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

    // ─── Categories ──────────────────────────────────────────────────────────
    //
    // A category is a folder: every bot is in exactly one, or in none
    // (Uncategorized). The list's order IS the display order. Filing a bot is
    // library bookkeeping, not an edit — it never bumps `rev` or `updatedAt`,
    // so moving a bot cannot collide with somebody editing it in the Builder.

    /** Every category, in display order. */
    listCategories() {
      return readAll().categories.map((category) => ({ ...category }));
    },

    /** Add a category at the end of the list; returns { categoryID }. */
    createCategory(name) {
      const all = readAll();
      const clean = categoryNameOf(name);
      guardUniqueName(all, clean, null);
      if (all.categories.length >= MAX_CATEGORIES) {
        throw fail("BOTCATEGORY_LIMIT_REACHED", "You have reached the limit of categories.");
      }
      const categoryID = uuid();
      all.categories.push({ categoryID, name: clean });
      writeAll(all);
      return { categoryID };
    },

    /** Rename a category. */
    renameCategory(categoryID, name) {
      const all = readAll();
      const category = findCategory(all, categoryID);
      const clean = categoryNameOf(name);
      guardUniqueName(all, clean, category.categoryID);
      category.name = clean;
      writeAll(all);
    },

    /** Move a category to `index` (clamped) in the display order. */
    moveCategory(categoryID, index) {
      const all = readAll();
      const category = findCategory(all, categoryID);
      const rest = all.categories.filter((row) => row !== category);
      const at = Math.max(0, Math.min(rest.length, Math.trunc(Number(index)) || 0));
      rest.splice(at, 0, category);
      all.categories = rest;
      writeAll(all);
    },

    /**
     * Delete a category. ⚠ ITS BOTS ARE NEVER DELETED: every bot filed in it
     * becomes Uncategorized. Returns { uncategorized } — how many moved.
     */
    removeCategory(categoryID) {
      const all = readAll();
      const category = findCategory(all, categoryID);
      all.categories = all.categories.filter((row) => row !== category);
      let uncategorized = 0;
      for (const record of Object.values(all.scripts)) {
        if (record.categoryID === category.categoryID) {
          record.categoryID = null;
          uncategorized += 1;
        }
      }
      writeAll(all);
      return { uncategorized };
    },

    /**
     * File bots in a category (null = Uncategorized). Every id must exist and
     * so must the category, or nothing moves. Returns { moved }.
     */
    setCategory(scriptIDs, categoryID) {
      const all = readAll();
      if (!Array.isArray(scriptIDs) || scriptIDs.length === 0) {
        throw fail("BOTSCRIPT_INVALID", "Choose at least one bot to move.");
      }
      const target = resolveCategoryID(all, categoryID === undefined ? null : categoryID);
      const records = scriptIDs.map((scriptID) => {
        const record = all.scripts[String(scriptID)];
        if (!record) {
          throw fail("BOTSCRIPT_NOT_FOUND", "That bot could not be found.");
        }
        return record;
      });
      for (const record of records) {
        record.categoryID = target;
      }
      writeAll(all);
      return { moved: records.length };
    },

    /**
     * Insert the six starter bots (src/starterBots.json) on first use, then
     * never again. This is a deliberate, explicit call — NOT run implicitly
     * from list()/get()/create() — so a plain read never has the write side
     * effect those methods already promise not to have.
     *
     * The `seededVersion` marker recorded on the store, not per-script
     * presence, is what makes this idempotent AND makes a deleted starter
     * stay deleted: once the marker is set, this returns immediately without
     * looking at which starter scriptIDs still exist. A library that grows
     * back what the player removed would be a bug, not a feature.
     *
     * Starter records use a deterministic scriptID (`starter-<id>`) purely as
     * a duplicate guard for a single seeding pass (for example a crash
     * between writeAll and the caller recording success); it is not what
     * prevents resurrection — the version marker is.
     *
     * Quota and byte caps apply exactly as they do to a player's create():
     * seeding stops (without throwing) once MAX_SCRIPTS_TOTAL is reached, so
     * a near-full store simply gets as many starters as fit.
     */
    seedStarterBots() {
      const all = readAll();
      if (all.seededVersion === STARTER_SEED_VERSION) {
        return { seeded: 0, alreadySeeded: true };
      }
      const starters = loadStarterBots();
      let total = Object.keys(all.scripts).length;
      let seeded = 0;
      for (const starter of starters) {
        const scriptID = `starter-${starter.id}`;
        if (all.scripts[scriptID]) {
          continue; // never overwrite or duplicate an existing record
        }
        if (total >= MAX_SCRIPTS_TOTAL) {
          break; // seeds count against the quota like any other record
        }
        const bytes = guardDoc(starter.doc);
        const timestamp = now();
        all.scripts[scriptID] = {
          scriptID,
          authorAccountID: null,
          authorName: STARTER_AUTHOR_NAME,
          rev: 1,
          name: nameOf(starter.doc),
          bytes,
          createdAt: timestamp,
          updatedAt: timestamp,
          categoryID: null,
          doc: starter.doc,
        };
        total += 1;
        seeded += 1;
      }
      all.seededVersion = STARTER_SEED_VERSION;
      writeAll(all);
      return { seeded, alreadySeeded: false };
    },
  };
}

module.exports = {
  createBotScriptStore,
  MAX_SCRIPTS_TOTAL,
  STARTER_SEED_VERSION,
  STARTER_AUTHOR_NAME,
  MAX_DOC_BYTES,
  MAX_NAME_LEN,
  MAX_CATEGORIES,
  MAX_CATEGORY_NAME_LEN,
  STORE_FILENAME,
};
