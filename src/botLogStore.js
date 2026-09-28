"use strict";

// The bot flight recorder's storage: one log per CHARACTER, rotated when a run
// starts, so the current run and the one before it are always on disk.
//
// WHY PER CHARACTER. A character is what flies. The question an operator
// actually asks is "what did this pilot do", across whatever script happened to
// be running — not "what did script X do", which could be three pilots at once.
//
// WHY TWO. The question is nearly always "what happened in the run that just
// ended", and occasionally "the one before, which was fine". A third file earns
// nothing and a directory that grows forever earns less than nothing. A run's
// `start` line is the rotation signal: current becomes previous, previous is
// dropped, and the new run writes from an empty file.
//
// ⚠ THE RECORDER IS NEVER LOAD-BEARING. Every failure here — a full disk, a
// path that cannot be created, a file that will not open — is swallowed and
// counted. A ship must never stop because its diary could not be written. That
// is the same promise the runner makes on the other side of the wire
// (web/src/nav/botLog.ts, rule 4), and both halves have to keep it for it to
// mean anything.
//
// BOUNDED, AND HONEST ABOUT IT. A run that writes past `maxLines` stops being
// written and gets ONE truncation line saying so — a log that silently stops
// recording is worse than one that says it stopped.
//
// NOT A GAME ARTIFACT. These lines name ids on purpose (see botLog.ts): they
// are the operator's own diagnostic file, written under the BFF's data dir,
// never served into the game UI's player-facing copy and never committed.

const fs = require("fs");
const path = require("path");

/** Past this many lines a run's log stops writing and says so. */
const DEFAULT_MAX_LINES = 5000;

function safeName(characterID) {
  const numeric = Number(characterID);
  return Number.isSafeInteger(numeric) && numeric > 0 ? String(numeric) : "";
}

/**
 * @param {object} options
 * @param {string} options.dir        Where the logs live (created on demand).
 * @param {number} [options.maxLines] Per-run ceiling before truncation.
 */
function createBotLogStore(options = {}) {
  const dir = String(options.dir || "");
  const maxLines = Number.isFinite(options.maxLines) && options.maxLines > 0
    ? Math.floor(options.maxLines)
    : DEFAULT_MAX_LINES;

  // characterID -> lines written to the CURRENT file, so the cap costs no read.
  const written = new Map();
  // Failures are counted rather than thrown, and reported by `stats()` so a
  // recorder that has quietly stopped working is still discoverable.
  let dropped = 0;

  function currentPath(name) {
    return path.join(dir, `${name}.jsonl`);
  }

  function previousPath(name) {
    return path.join(dir, `${name}.prev.jsonl`);
  }

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  /** current -> previous, and the new run starts from nothing. */
  function rotate(name) {
    const current = currentPath(name);
    const previous = previousPath(name);
    try {
      if (fs.existsSync(current)) {
        fs.rmSync(previous, { force: true });
        fs.renameSync(current, previous);
      }
    } catch {
      // A rotation that fails costs the PREVIOUS run's log, never the new one:
      // the append below truncates the current file either way.
    }
    written.set(name, 0);
  }

  /**
   * Append lines for one character. A `start` line rotates first — that is the
   * whole rotation rule, and it lives here rather than in a route so a server
   * bot and a tab bot cannot disagree about when a run began.
   *
   * Answers how many lines were written; never throws.
   */
  function append(characterID, entries) {
    const name = safeName(characterID);
    if (!name || !Array.isArray(entries) || entries.length === 0) {
      return 0;
    }
    let text = "";
    let count = 0;
    try {
      ensureDir();
      for (const entry of entries) {
        if (entry === null || typeof entry !== "object") {
          continue;
        }
        if (entry.kind === "start") {
          // Flush what this batch has so far into the OLD file before rotating,
          // or a batch that spans a restart would lose the end of the last run.
          if (text.length > 0) {
            fs.appendFileSync(currentPath(name), text, "utf8");
            text = "";
          }
          rotate(name);
        }
        const already = written.get(name) ?? 0;
        if (already >= maxLines) {
          if (already === maxLines) {
            text += `${JSON.stringify({ t: new Date().toISOString(), kind: "truncated", maxLines })}\n`;
            written.set(name, already + 1);
          }
          continue;
        }
        text += `${JSON.stringify({ ...entry, characterID: Number(name) })}\n`;
        written.set(name, already + 1);
        count += 1;
      }
      if (text.length > 0) {
        fs.appendFileSync(currentPath(name), text, "utf8");
      }
      return count;
    } catch {
      dropped += entries.length;
      return 0;
    }
  }

  /**
   * The lines of one character's current or previous run, newest file read
   * whole (they are bounded by `maxLines`). A missing file is an empty list —
   * "this pilot has not run a bot" is a real answer, not a failure.
   */
  function read(characterID, which = "current") {
    const name = safeName(characterID);
    if (!name) {
      return [];
    }
    const file = which === "previous" ? previousPath(name) : currentPath(name);
    try {
      if (!fs.existsSync(file)) {
        return [];
      }
      return fs
        .readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            // A half-written last line (a kill mid-append) is data too — say so
            // rather than dropping it silently.
            return { kind: "unreadable", raw: line.slice(0, 200) };
          }
        });
    } catch {
      return [];
    }
  }

  /** How many lines this process has failed to write. Zero on a healthy BFF. */
  function stats() {
    return { dropped };
  }

  return { append, read, stats };
}

module.exports = { createBotLogStore, DEFAULT_MAX_LINES };
