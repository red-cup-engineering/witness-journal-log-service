// witness-journal-log-service — append-only journal custody.
//
// A witness journal is one date-partitioned, append-only JSONL file per
// (feed, day): `<root>/data/logs/<feed>-logs/<date>-admit-<feed>.jsonl`. This is the
// irreducible tier — the log is never a sufficient statistic of anything
// else, everything else (state readouts, settled records) is a projection
// of it. This module is the sole effectful membrane: the only file here that
// touches node:fs.
//
// Two laws this module carries that the entry service deliberately does not:
//
//   - strict semantic dedup: an admitted SEAVT witness already present under
//     the same explicit feed/day custody costs nothing. Generic JSON EAVT is
//     only compared by canonical carrier equality and never receives a
//     semantic identity here.
//   - trace: an entry's trace is its ordinal position in the journal, i.e.
//     its 1-based index in append order. Trace is never stored in the entry
//     or in the file; it is computed fresh every time the journal is read,
//     from where each entry sits in that reading.

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { journalPath } from "@red-cup-engineering/eavt-services-section/journal-path";
import { canonical } from "@red-cup-engineering/json-file-codec-service";
import { parse, serialize } from "@red-cup-engineering/json-file-codec-service/jsonl/eavt";
import { asEntry, asSeavt, identifySeavtSemanticContent } from "@red-cup-engineering/witness-journal-entry-service";

/**
 * @typedef {import("@red-cup-engineering/witness-journal-entry-service").WitnessJournalEntry} WitnessJournalEntry
 * @typedef {import("@red-cup-engineering/witness-journal-entry-service").Seavt} Seavt
 * @typedef {{ readonly entry: WitnessJournalEntry, readonly trace: number }} TracedEntry
 * @typedef {{ readonly entry: Seavt, readonly trace: number }} TracedSeavt
 */

/** The UTC date (YYYY-MM-DD) named by a witness time; a safe fallback bucket
 *  otherwise, so a malformed `at` still lands somewhere instead of throwing. */
function dateOf(at) {
  const text = typeof at === "string" ? at : canonical(at);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "0000-00-00";
}

/**
 * The dated journal path for one feed: `<root>/data/logs/<feed>-logs/<date>-admit-<feed>.jsonl`,
 * addressed by the eavt-services-section tier law. The date is derived from `at` (a witness-journal time value), not from the
 * wall clock — replaying an old witness files it under the day it witnesses,
 * not the day it happens to be replayed.
 *
 * @param {string} root
 * @param {string} feed
 * @param {import("@red-cup-engineering/json-file-codec-service").JsonValue} at
 * @returns {string}
 */
export function logPathFor(root, feed, at) {
  return journalPath({ root, feed, at });
}

/**
 * Read one journal file's entries at an exact path, in append order. A
 * missing or unreadable file reads as the empty journal — the empty journal
 * is a first-class state, not an exceptional one.
 *
 * @param {string} filePath
 * @returns {WitnessJournalEntry[]}
 */
export function readEntriesAtPath(filePath) {
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  return /** @type {WitnessJournalEntry[]} */ (parse(content));
}

/**
 * Read one journal file as strict SEAVT source rows. A present generic EAVT
 * row is refused rather than silently promoted into the semiotic source law.
 *
 * @param {string} filePath
 * @returns {Seavt[]}
 */
export function readSeavtAtPath(filePath) {
  return readEntriesAtPath(filePath).map((row) => asSeavt(row));
}

/**
 * Read any newline-delimited JSON at an exact path, one value per line,
 * skipping malformed lines. Unlike `readEntriesAtPath`, rows need not be
 * entry-shaped — this is the generic fallback reader for JSONL that predates
 * or otherwise does not conform to the entry law.
 *
 * @param {string} filePath
 * @returns {import("@red-cup-engineering/json-file-codec-service").JsonValue[]}
 */
export function readJsonLinesAtPath(filePath) {
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A malformed line is absent from this reading.
    }
  }
  return out;
}

/**
 * Atomically write a journal file's full entry set at an exact path: write
 * to a sibling temp file, then rename over the target (atomic on POSIX), so
 * a crash mid-write never corrupts the live journal.
 *
 * @param {string} filePath
 * @param {readonly unknown[]} entries
 */
export function writeEntriesAtomicAtPath(filePath, entries) {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    writeFileSync(tmp, serialize(/** @type {any} */ (entries.map((row) => asEntry(row)))), "utf8");
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup: preserve the original write/rename failure.
    }
    throw error;
  }
}

/**
 * Append only generic JSON entries not already present by canonical carrier
 * equality. This compatibility lane deliberately does not mint semantic
 * identity.
 * Reappending an already-witnessed entry is free: it is skipped, and the
 * returned `appended` count — the journal's growth signal — is 0 when
 * nothing was genuinely new.
 *
 * @param {string} root
 * @param {string} feed
 * @param {readonly unknown[]} rows
 * @param {import("@red-cup-engineering/json-file-codec-service").JsonValue} at
 * @returns {{ readonly appended: number }}
 */
function appendGenericEntries(root, feed, rows, at) {
  if (rows.length === 0) return { appended: 0 };
  const filePath = logPathFor(root, feed, at);
  const present = new Set(readEntriesAtPath(filePath).map((row) => canonical(row)));
  const fresh = [];
  for (const row of rows) {
    const normalized = asEntry(row);
    const key = canonical(normalized);
    if (present.has(key)) continue;
    present.add(key);
    fresh.push(normalized);
  }
  if (fresh.length === 0) return { appended: 0 };
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, serialize(/** @type {any} */ (fresh)), "utf8");
  return { appended: fresh.length };
}


export function appendEntries(root, feed, rows, at) {
  return appendGenericEntries(root, feed, rows, at);
}

function custodyWitness(feed, at) {
  if (typeof feed !== "string" || feed.length === 0) {
    throw new TypeError("SEAVT custody: feed must be a nonempty string");
  }
  return Object.freeze({
    kind: "witness-journal.log.custody",
    feed,
    partition: dateOf(at),
  });
}

/**
 * Append strict SEAVT rows under the v2 semantic-content law;
 * `appendEntries` remains the explicitly non-semantic JSON compatibility lane.
 *
 * @param {string} root
 * @param {string} feed
 * @param {readonly unknown[]} rows
 * @param {import("@red-cup-engineering/json-file-codec-service").JsonValue} at
 * @returns {{ readonly appended: number }}
 */
export function appendSeavt(root, feed, rows, at) {
  if (rows.length === 0) return { appended: 0 };
  const filePath = logPathFor(root, feed, at);
  const custody = custodyWitness(feed, at);
  const present = new Set(readSeavtAtPath(filePath).map((row) =>
    identifySeavtSemanticContent(row, custody).token));
  const fresh = [];
  for (const row of rows) {
    const normalized = asSeavt(row);
    const token = identifySeavtSemanticContent(normalized, custody).token;
    if (present.has(token)) continue;
    present.add(token);
    fresh.push(normalized);
  }
  if (fresh.length === 0) return { appended: 0 };
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, serialize(/** @type {any} */ (fresh)), "utf8");
  return { appended: fresh.length };
}

/**
 * Read one feed's journal for a given day, with each entry's trace attached
 * — its 1-based ordinal position in append order. Trace is computed here,
 * at read time, from physical file order; it is never stored.
 *
 * @param {string} root
 * @param {string} feed
 * @param {import("@red-cup-engineering/json-file-codec-service").JsonValue} at
 * @returns {readonly TracedEntry[]}
 */
export function readEntries(root, feed, at) {
  const rows = readEntriesAtPath(logPathFor(root, feed, at));
  return Object.freeze(rows.map((row, index) => Object.freeze({ entry: row, trace: index + 1 })));
}

/** Read one dated SEAVT journal with derived 1-based trace. */
export function readSeavt(root, feed, at) {
  const rows = readSeavtAtPath(logPathFor(root, feed, at));
  return Object.freeze(rows.map((row, index) => Object.freeze({ entry: row, trace: index + 1 })));
}

/**
 * The same ordered, traced reading as `readEntries`, offered as a generator
 * — the "stream" half of "ordered read/stream". The current implementation
 * reads the whole journal first and yields from it; a later incremental or
 * tailing implementation can replace the body without changing this shape.
 *
 * @param {string} root
 * @param {string} feed
 * @param {import("@red-cup-engineering/json-file-codec-service").JsonValue} at
 * @returns {Generator<TracedEntry, void, void>}
 */
export function* streamEntries(root, feed, at) {
  for (const traced of readEntries(root, feed, at)) yield traced;
}

/** Stream the same strict, ordered SEAVT reading returned by `readSeavt`. */
export function* streamSeavt(root, feed, at) {
  for (const traced of readSeavt(root, feed, at)) yield traced;
}
