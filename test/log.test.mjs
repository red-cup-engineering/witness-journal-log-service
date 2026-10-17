import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse as parseEavt } from "@red-cup-engineering/json-file-codec-service/jsonl/eavt";
import { entry, seavt } from "@red-cup-engineering/witness-journal-entry-service";
import {
  logPathFor,
  appendEntries,
  readEntries,
  readEntriesAtPath,
  readJsonLinesAtPath,
  writeEntriesAtomicAtPath,
  streamEntries,
  appendSeavt,
  readSeavt,
  readSeavtAtPath,
  streamSeavt,
} from "../src/index.mjs";

function withTempRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "witness-journal-log-test-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("logPathFor files the journal by kind under data/logs, the date leading the file's stem", () => {
  withTempRoot((root) => {
    const p = logPathFor(root, "agent-events", "2026-07-31T12:00:00.000Z");
    assert.equal(p, path.join(root, "data", "logs", "agent-events-logs", "2026-07-31-admit-agent-events.jsonl"));
  });
});

test("appendEntries writes a real journal, readable back through the eavt codec", () => {
  withTempRoot((root) => {
    const at = "2026-07-31T12:00:00.000Z";
    const rows = [
      entry("s1", "urn:rmn:observed", 1, at),
      entry("s2", "urn:rmn:observed", 2, at),
    ];
    const result = appendEntries(root, "feed-a", rows, at);
    assert.equal(result.appended, 2);

    const filePath = logPathFor(root, "feed-a", at);
    const raw = readFileSync(filePath, "utf8");
    const decoded = parseEavt(raw);
    assert.equal(decoded.length, 2);
    assert.deepEqual(decoded, rows);
  });
});

test("dedup: reappending the same witnesses costs nothing, asserted by row count", () => {
  withTempRoot((root) => {
    const at = "2026-07-31T12:00:00.000Z";
    const rows = [
      entry("s1", "urn:rmn:observed", 1, at),
      entry("s2", "urn:rmn:observed", 2, at),
      entry("s3", "urn:rmn:observed", 3, at),
    ];
    const first = appendEntries(root, "feed-b", rows, at);
    assert.equal(first.appended, 3);

    // Reappend the exact same witnesses, plus nothing new.
    const second = appendEntries(root, "feed-b", rows, at);
    assert.equal(second.appended, 0);

    const afterRows = readEntriesAtPath(logPathFor(root, "feed-b", at));
    assert.equal(afterRows.length, 3, "row count must not grow on a repeated witness");

    // Reappend a mix of old and one genuinely new witness.
    const third = appendEntries(
      root,
      "feed-b",
      [...rows, entry("s4", "urn:rmn:observed", 4, at)],
      at,
    );
    assert.equal(third.appended, 1);
    const finalRows = readEntriesAtPath(logPathFor(root, "feed-b", at));
    assert.equal(finalRows.length, 4);
  });
});

test("trace is the entry's ordinal at read time, in append order, never stored", () => {
  withTempRoot((root) => {
    const at = "2026-07-31T12:00:00.000Z";
    appendEntries(root, "feed-c", [entry("s1", "urn:rmn:observed", "a", at)], at);
    appendEntries(root, "feed-c", [entry("s2", "urn:rmn:observed", "b", at)], at);
    appendEntries(root, "feed-c", [entry("s3", "urn:rmn:observed", "c", at)], at);

    const traced = readEntries(root, "feed-c", at);
    assert.equal(traced.length, 3);
    assert.deepEqual(traced.map((t) => t.trace), [1, 2, 3]);
    assert.deepEqual(traced.map((t) => t.entry.v), ["a", "b", "c"]);

    // Trace is never written to the file: the file holds only e/a/v/t rows.
    const onDisk = readEntriesAtPath(logPathFor(root, "feed-c", at));
    for (const row of onDisk) assert.equal("trace" in row, false);
  });
});

test("streamEntries yields the same ordered, traced entries as readEntries", () => {
  withTempRoot((root) => {
    const at = "2026-07-31T12:00:00.000Z";
    appendEntries(
      root,
      "feed-d",
      [entry("s1", "urn:rmn:observed", "x", at), entry("s2", "urn:rmn:observed", "y", at)],
      at,
    );
    const streamed = [...streamEntries(root, "feed-d", at)];
    const read = readEntries(root, "feed-d", at);
    assert.deepEqual(streamed, read);
  });
});

test("a missing journal reads as empty, not an error", () => {
  withTempRoot((root) => {
    assert.deepEqual(readEntries(root, "never-witnessed", "2026-07-31T00:00:00.000Z"), []);
    assert.deepEqual(readEntriesAtPath(path.join(root, "nope.jsonl")), []);
    assert.deepEqual(readJsonLinesAtPath(path.join(root, "nope.jsonl")), []);
  });
});

test("readJsonLinesAtPath reads generic JSON lines without weakening their contents", () => {
  withTempRoot((root) => {
    const filePath = path.join(root, "raw.jsonl");
    writeEntriesAtomicAtPath(filePath, [entry("s", "p", "v", "t")]);
    // writeEntriesAtomicAtPath writes entry-shaped rows; readJsonLinesAtPath
    // must still read them back as generic JSON (no shape enforcement).
    const rows = readJsonLinesAtPath(filePath);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { e: "s", a: "p", v: "v", t: "t" });
  });
});

test("unreadable present journals refuse rather than appear empty", () => {
  withTempRoot((root) => {
    const directory = path.join(root, "present-but-not-a-file");
    mkdirSync(directory);
    assert.throws(() => readEntriesAtPath(directory), error => error?.code === "EISDIR");
    assert.throws(() => readJsonLinesAtPath(directory), error => error?.code === "EISDIR");
    assert.throws(() => readSeavtAtPath(directory), error => error?.code === "EISDIR");
    // A caller may still read an actually missing file as empty.
    assert.deepEqual(readJsonLinesAtPath(path.join(root, "absent.jsonl")), []);
  });
});

test("invalid JSONL refuses with the source line, preserving every surviving byte", () => {
  withTempRoot((root) => {
    const filePath = path.join(root, "source.jsonl");
    const source = '{"record":1}\n{"broken":\n{"record":3}\n';
    writeFileSync(filePath, source);
    assert.throws(() => readJsonLinesAtPath(filePath), error =>
      error instanceof SyntaxError && error.message.includes(filePath + ":2"));
    assert.equal(readFileSync(filePath, "utf8"), source);
  });
});

test("writeEntriesAtomicAtPath fully replaces a journal file (used for settlement compaction)", () => {
  withTempRoot((root) => {
    const at = "2026-07-31T12:00:00.000Z";
    appendEntries(
      root,
      "feed-e",
      [entry("s1", "p", "v1", at), entry("s2", "p", "v2", at), entry("s3", "p", "v3", at)],
      at,
    );
    const filePath = logPathFor(root, "feed-e", at);
    const kept = [entry("s2", "p", "v2", at)];
    writeEntriesAtomicAtPath(filePath, kept);
    const after = readEntriesAtPath(filePath);
    assert.deepEqual(after, kept);
  });
});

test("strict SEAVT custody deduplicates source rows and derives trace without storing it", () => {
  withTempRoot((root) => {
    const at = "2026-08-02T00:00:00.000Z";
    const rows = [
      seavt("order.payment", "payment:receipt", "receipt-delay", at),
      seavt("order.payment", "receipt:accepted", "accepted.notice", at),
    ];

    assert.deepEqual(appendSeavt(root, "semiotic", rows, at), { appended: 2 });
    assert.deepEqual(appendSeavt(root, "semiotic", rows, at), { appended: 0 });
    assert.deepEqual(readSeavtAtPath(logPathFor(root, "semiotic", at)), rows);
    const traced = readSeavt(root, "semiotic", at);
    assert.deepEqual(traced.map(({ trace }) => trace), [1, 2]);
    assert.deepEqual([...streamSeavt(root, "semiotic", at)], traced);
    for (const row of readSeavtAtPath(logPathFor(root, "semiotic", at))) {
      assert.equal("trace" in row, false);
      assert.equal("charge" in row, false);
    }
  });
});

test("strict SEAVT custody refuses generic EAVT and underscore escapes", () => {
  withTempRoot((root) => {
    const at = "2026-08-02T00:00:00.000Z";
    assert.throws(() => appendSeavt(root, "semiotic", [entry("subject", { arbitrary: true }, 4, at)], at), /SEAVT row/);
    assert.throws(() => appendSeavt(root, "semiotic", [{ e: "order_payment", a: "payment:receipt", v: "receipt-delay", t: at }], at), /SEAVT row/);
  });
});
