// Hand-written declaration file. This package ships plain .mjs (no build
// step, no TypeScript source) — this file exists only so strict TypeScript
// consumers (e.g. organizing) can typecheck against it.

import type { JsonValue } from "@red-cup-engineering/json-file-codec-service";
import type { Seavt, WitnessJournalEntry } from "@red-cup-engineering/witness-journal-entry-service";

/** One entry paired with its trace — the entry's ordinal position (1-based)
 *  in the journal at the moment it was read. Never stored; always derived. */
export interface TracedEntry {
  readonly entry: WitnessJournalEntry;
  readonly trace: number;
}

/** One strict SEAVT row paired with its derived 1-based append ordinal. */
export interface TracedSeavt {
  readonly entry: Seavt;
  readonly trace: number;
}

/**
 * The directories a caller-owned witness store may hold. Only `logDir` is
 * used by this package; the others are accepted so callers that also keep a
 * state/record/content tier of their own can reuse one shape across all of
 * them.
 */
export interface WitnessJournalDirectories {
  readonly logDir: string;
  readonly stateDir?: string;
  readonly recordDir?: string;
  readonly contentDir?: string;
}

export declare function logPathFor(root: string, feed: string, at: JsonValue): string;
export declare function readEntriesAtPath(filePath: string): WitnessJournalEntry[];
export declare function readSeavtAtPath(filePath: string): Seavt[];
export declare function readJsonLinesAtPath(filePath: string): JsonValue[];
export declare function appendEntries(
  root: string,
  feed: string,
  rows: readonly unknown[],
  at: JsonValue,
): { readonly appended: number };
export declare function appendSeavt(
  root: string,
  feed: string,
  rows: readonly unknown[],
  at: JsonValue,
): { readonly appended: number };
export declare function readEntries(root: string, feed: string, at: JsonValue): readonly TracedEntry[];
export declare function readSeavt(root: string, feed: string, at: JsonValue): readonly TracedSeavt[];
export declare function streamEntries(root: string, feed: string, at: JsonValue): Generator<TracedEntry, void, void>;
export declare function streamSeavt(root: string, feed: string, at: JsonValue): Generator<TracedSeavt, void, void>;
