/**
 * Scenarios as JSON files, one per scenario: `<dir>/<name>.json`. Writes are
 * atomic (temp file + rename) so a crash never leaves half a scenario.
 * `get` reports why a file cannot be read; `list` skips it.
 *
 * A scenario is the prompt only — start URL, goal, values, secret names — and
 * is written only when saved. How a run of it went (the recording) is kept in
 * the recording cache (`cache.ts`), which is not committed.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { CandidateKind } from "../text/types";
import { Scenario, SCENARIO_FORMAT_VERSION } from "./types";

const NAME: RegExp = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export class ScenarioError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ScenarioError";
    }
}

/**
 * Whether `name`, as given, is a scenario name (`validateScenarioName` normalizes an input and
 * says why not). A file stem is tested as it is: `" shop"` is a stray file, not `shop` again.
 */
export function isScenarioName(name: string): boolean {
    return NAME.test(name);
}

export function validateScenarioName(name: string): string {
    const trimmed: string = name.trim();
    if (!NAME.test(trimmed)) {
        throw new ScenarioError(
            `Invalid scenario name ${JSON.stringify(name)}: letters, digits, "-" and "_", up to 64, starting with a letter or digit`
        );
    }
    return trimmed;
}

const CANDIDATE_KINDS: ReadonlySet<CandidateKind> = new Set(Object.values(CandidateKind));

/**
 * Identifies the prompt a recording was made for. The URL is normalised (`https://x.test` and
 * `https://x.test/` are one page): the CLI passes it as typed, the UI as `URL` spells it.
 */
export function promptHash(goal: string, url: string | undefined): string {
    const page: string = url !== undefined && URL.canParse(url) ? new URL(url).href : (url ?? "");
    return createHash("sha256")
        .update(`${goal.trim()}\n${page}`)
        .digest("hex")
        .slice(0, 16);
}

export interface ScenarioSummary {
    name: string;
    description?: string;
    goal: string;
    url?: string;
    updatedAt: string;
}

function isStringMap(value: unknown): boolean {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.values(value as Record<string, unknown>).every((v: unknown): boolean => typeof v === "string")
    );
}

function isStringList(value: unknown): boolean {
    return Array.isArray(value) && value.every((v: unknown): boolean => typeof v === "string");
}

export class ScenarioStore {
    constructor(readonly dir: string) {}

    private file(name: string): string {
        return join(this.dir, `${validateScenarioName(name)}.json`);
    }

    exists(name: string): boolean {
        return existsSync(this.file(name));
    }

    get(name: string): Scenario {
        const file: string = this.file(name);
        if (!existsSync(file)) {
            throw new ScenarioError(`No scenario named ${JSON.stringify(name)} in ${this.dir}`);
        }
        let parsed: Scenario & { recording?: unknown };
        try {
            parsed = JSON.parse(readFileSync(file, "utf-8")) as Scenario & { recording?: unknown };
        } catch (err: unknown) {
            throw new ScenarioError(`Scenario ${name} is not valid JSON: ${err instanceof Error ? err.message : err}`);
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new ScenarioError(`Scenario ${name} is not a scenario file (its JSON is not an object)`);
        }
        // Any other JSON object (a cache file, a hand-made one) is not a scenario either: `list`
        // skips it, and nothing downstream reads `goal.slice` off undefined.
        if (typeof parsed.goal !== "string") {
            throw new ScenarioError(`Scenario ${name} is not a scenario file (no goal)`);
        }
        // Each field's entries too: a committed `"qty": 2` would otherwise fail the run on `.trim`.
        for (const field of ["values", "descriptions"] as const) {
            if (parsed[field] !== undefined && !isStringMap(parsed[field])) {
                throw new ScenarioError(`Scenario ${name} is not a scenario file (${field} is not an object of strings)`);
            }
        }
        // The single strings too: a committed `"description": 1` would fail `scenarios list` on
        // `.slice`, a `"profile": true` the run on `.trim`.
        for (const field of ["description", "url", "profile", "textModel"] as const) {
            if (parsed[field] !== undefined && typeof parsed[field] !== "string") {
                throw new ScenarioError(`Scenario ${name} is not a scenario file (${field} is not a string)`);
            }
        }
        if (parsed.stealth !== undefined && typeof parsed.stealth !== "boolean") {
            throw new ScenarioError(`Scenario ${name} is not a scenario file (stealth is not true or false)`);
        }
        // A kind this version does not know would fail the run in the text setup, not here.
        if (
            parsed.textCandidates !== undefined &&
            !(Array.isArray(parsed.textCandidates) && parsed.textCandidates.every((k: unknown): boolean => CANDIDATE_KINDS.has(k as CandidateKind)))
        ) {
            throw new ScenarioError(`Scenario ${name} is not a scenario file (textCandidates is not a list of text candidate kinds)`);
        }
        for (const field of ["secretNames", "passwordSecrets"] as const) {
            if (parsed[field] !== undefined && !isStringList(parsed[field])) {
                throw new ScenarioError(`Scenario ${name} is not a scenario file (${field} is not a list of strings)`);
            }
        }
        if (parsed.formatVersion > SCENARIO_FORMAT_VERSION) {
            throw new ScenarioError(
                `Scenario ${name} has format ${parsed.formatVersion}; this version reads up to ${SCENARIO_FORMAT_VERSION}`
            );
        }
        // A recording in an older file is not the scenario's: recordings live in the cache.
        // The scenario is named by its file: a renamed file is listed, read and deleted by that name.
        const { recording: _recording, ...scenario } = parsed;
        return { ...scenario, name: validateScenarioName(name) };
    }

    /** Writes the scenario itself (the prompt); never a recording. */
    save(scenario: Scenario): Scenario {
        const { recording: _recording, ...prompt } = scenario as Scenario & { recording?: unknown };
        const file: string = this.file(prompt.name);
        mkdirSync(this.dir, { recursive: true });
        const temp: string = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, `${JSON.stringify(prompt, null, 2)}\n`, "utf-8");
        renameSync(temp, file);
        return prompt;
    }

    delete(name: string): boolean {
        const file: string = this.file(name);
        if (!existsSync(file)) {
            return false;
        }
        rmSync(file);
        return true;
    }

    list(): ScenarioSummary[] {
        if (!existsSync(this.dir)) {
            return [];
        }
        const out: ScenarioSummary[] = [];
        for (const entry of readdirSync(this.dir)) {
            const stem: string = entry.slice(0, -".json".length);
            if (!entry.endsWith(".json") || !isScenarioName(stem)) {
                continue;
            }
            try {
                const s: Scenario = this.get(stem);
                out.push({
                    name: s.name,
                    ...(s.description ? { description: s.description } : {}),
                    goal: s.goal,
                    url: s.url,
                    updatedAt: s.updatedAt,
                });
            } catch {
                // An unreadable or foreign file is not a scenario; `get` reports why when asked for it.
            }
        }
        return out.sort((a: ScenarioSummary, b: ScenarioSummary): number => a.name.localeCompare(b.name));
    }
}
