/**
 * The recordings of scenario runs: a cache, kept apart from the scenarios (it is not committed).
 *
 * One file per scenario, `<dir>/<scenario>.json`, holding up to `maxEntries` recordings, one for each
 * prompt (goal + start URL, by `promptHash`) the scenario passed with: the latest passing run's. A run
 * with an edited goal is cached beside the scenario's own prompt without changing the scenario, and
 * going back to a prompt finds its recording again. Past `maxEntries` the entry used longest ago goes.
 *
 * Values are not part of the key: a recording types values and secrets by NAME and takes them from
 * the run that replays it, so a new email or password replays the same steps.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Operation } from "../agent/policy";
import { RECORDED, TARGETED } from "./recording";
import { isScenarioName, validateScenarioName } from "./store";
import { Recording } from "./types";

export const CACHE_FORMAT_VERSION: number = 1;
export const DEFAULT_CACHE_ENTRIES: number = 5;

export interface CacheEntry {
    promptHash: string;
    /** The prompt it was recorded for, for reading. */
    goal: string;
    url?: string;
    recording: Recording;
    /** Last recorded or replayed: the least recently used entry is evicted first. */
    lastUsedAt: string;
}

interface CacheFile {
    formatVersion: number;
    scenario: string;
    entries: CacheEntry[];
}

export interface CacheSummary {
    entries: number;
    /** The newest recording's time. */
    latestAt?: string;
}

/** A target as `findTarget` reads it: a hand-edited `"context": 5` would fail the run on `.toLowerCase`. */
function isDescriptor(target: unknown): boolean {
    if (target === null || typeof target !== "object") {
        return false;
    }
    const t: { role?: unknown; name?: unknown; context?: unknown; ordinal?: unknown } = target as {
        role?: unknown;
        name?: unknown;
        context?: unknown;
        ordinal?: unknown;
    };
    return (
        typeof t.role === "string" &&
        typeof t.name === "string" &&
        (t.context === undefined || typeof t.context === "string") &&
        (t.ordinal === undefined || (typeof t.ordinal === "number" && Number.isInteger(t.ordinal) && t.ordinal >= 0))
    );
}

/** An entry as a file may hold it: only a well-formed one is a recording this code can replay. */
function wellFormed(entry: unknown): entry is CacheEntry {
    if (!entry || typeof entry !== "object") {
        return false;
    }
    const e: Partial<CacheEntry> = entry as Partial<CacheEntry>;
    return (
        typeof e.promptHash === "string" &&
        typeof e.lastUsedAt === "string" &&
        e.recording !== null &&
        typeof e.recording === "object" &&
        Array.isArray(e.recording.steps) &&
        // Every step an object with an operation a replay can carry out: a hand-edited `null`, a
        // `WAIT` or a lower-cased `click` would fail the run before (or as) it starts — and one that
        // acts on a control names that control (a `SELECT` with no target has nothing to act on).
        e.recording.steps.every((step: unknown): boolean => {
            if (step === null || typeof step !== "object") {
                return false;
            }
            const s: { operation?: unknown; target?: unknown } = step as { operation?: unknown; target?: unknown };
            if (!RECORDED.has(s.operation as Operation)) {
                return false;
            }
            return !TARGETED.has(s.operation as Operation) || isDescriptor(s.target);
        }) &&
        typeof e.recording.recordedAt === "string"
    );
}

export class RecordingCache {
    /**
     * `onWriteError`: where a failed write goes instead of a throw. A run passes its warning
     * hook — a cache directory it cannot write must not fail a run that passed, nor stop a
     * replay whose recording it just read. Without it (the CLI's `scenarios` commands) the
     * error surfaces as it is.
     */
    constructor(
        readonly dir: string,
        readonly maxEntries: number = DEFAULT_CACHE_ENTRIES,
        private readonly onWriteError?: (message: string) => void
    ) {}

    private file(scenario: string): string {
        return join(this.dir, `${validateScenarioName(scenario)}.json`);
    }

    private read(scenario: string): CacheFile {
        const file: string = this.file(scenario);
        const empty: CacheFile = { formatVersion: CACHE_FORMAT_VERSION, scenario, entries: [] };
        if (!existsSync(file)) {
            return empty;
        }
        try {
            const parsed: CacheFile = JSON.parse(readFileSync(file, "utf-8")) as CacheFile;
            // A cache this version cannot read is only a cache: start it over.
            if (parsed === null || typeof parsed !== "object" || parsed.formatVersion !== CACHE_FORMAT_VERSION || !Array.isArray(parsed.entries)) {
                return empty;
            }
            // The file is the scenario's by its name: a copied file writes back to itself, never to the
            // scenario it came from. An entry this code cannot replay (hand-edited, another tool's) is dropped.
            return { ...parsed, scenario, entries: (parsed.entries as unknown[]).filter(wellFormed) };
        } catch {
            return empty;
        }
    }

    /** Writes the file (removes it when empty); false when it could not and `onWriteError` took the error. */
    private write(cache: CacheFile): boolean {
        const file: string = this.file(cache.scenario);
        try {
            if (cache.entries.length === 0) {
                rmSync(file, { force: true });
                return true;
            }
            mkdirSync(this.dir, { recursive: true });
            const temp: string = `${file}.${process.pid}.tmp`;
            writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, "utf-8");
            renameSync(temp, file);
            return true;
        } catch (err: unknown) {
            if (!this.onWriteError) {
                throw err;
            }
            this.onWriteError(`recording cache ${file} could not be written: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }

    /** The recording of this prompt, if one passed; marks it used. */
    get(scenario: string, promptHash: string): Recording | undefined {
        const cache: CacheFile = this.read(scenario);
        const entry: CacheEntry | undefined = cache.entries.find((e: CacheEntry): boolean => e.promptHash === promptHash);
        if (!entry) {
            return undefined;
        }
        entry.lastUsedAt = new Date().toISOString();
        this.write(cache);
        return entry.recording;
    }

    /** Keeps a passing run's recording for its prompt, replacing that prompt's older one; false when it could not be written. */
    put(scenario: string, entry: Omit<CacheEntry, "lastUsedAt">): boolean {
        const cache: CacheFile = this.read(scenario);
        const others: CacheEntry[] = cache.entries.filter((e: CacheEntry): boolean => e.promptHash !== entry.promptHash);
        // The recording that just passed is kept whatever the others' clocks say (a copied file
        // may carry later `lastUsedAt`s); only the older entries compete for the remaining slots.
        const kept: CacheEntry[] = others
            .sort((a: CacheEntry, b: CacheEntry): number => b.lastUsedAt.localeCompare(a.lastUsedAt))
            .slice(0, Math.max(1, this.maxEntries) - 1);
        const entries: CacheEntry[] = [{ ...entry, lastUsedAt: new Date().toISOString() }, ...kept];
        return this.write({ formatVersion: CACHE_FORMAT_VERSION, scenario, entries });
    }

    summary(scenario: string): CacheSummary {
        const entries: CacheEntry[] = this.read(scenario).entries;
        const latestAt: string | undefined = entries
            .map((e: CacheEntry): string => e.recording.recordedAt)
            .sort()
            .at(-1);
        return { entries: entries.length, ...(latestAt ? { latestAt } : {}) };
    }

    /** The recording kept for exactly this prompt, without marking it used. */
    peek(scenario: string, promptHash: string): Recording | undefined {
        return this.read(scenario).entries.find((e: CacheEntry): boolean => e.promptHash === promptHash)?.recording;
    }

    /** Drops a scenario's recordings; true when there were any. */
    clear(scenario: string): boolean {
        const file: string = this.file(scenario);
        if (!existsSync(file)) {
            return false;
        }
        rmSync(file, { force: true });
        return true;
    }

    /** The scenarios that have recordings (a stray file whose name is no scenario's is not one). */
    scenarios(): string[] {
        if (!existsSync(this.dir)) {
            return [];
        }
        return readdirSync(this.dir)
            .filter((f: string): boolean => f.endsWith(".json"))
            .map((f: string): string => f.slice(0, -".json".length))
            .filter((name: string): boolean => isScenarioName(name));
    }
}
