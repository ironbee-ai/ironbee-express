/**
 * All configuration, from the environment (a `.env` in the working directory
 * is loaded by the CLI first). CLI flags and the UI override per run.
 */

import { join } from "path";
import { DEFAULT_MAX_ACTIONS, DEFAULT_MAX_DECISIONS } from "../agent/budgets";
import { EngineConfig } from "../engine";
import { EngineKind } from "../engine/types";
import { IronBeeConfig, resolveIronBeeConfig } from "../ironbee/config";
import { DEFAULT_CACHE_ENTRIES } from "../scenario/cache";
import { DEFAULT_BASE_URLS, findOnPath, parseTextModel, ProviderSettings, TextConfig, TextProvider } from "../text";
import { CandidateKind } from "../text/types";

export const DEFAULT_DAEMON_PORT: number = 2071;
export const DEFAULT_UI_PORT: number = 15986;

export interface DaemonConfig {
    /** A running daemon to use; unset = start one. */
    url?: string;
    /** Port for a started daemon (the CLI; the UI picks a free one). */
    port: number;
    /** daemon-server.js to start; else the installed @ironbee-ai/devtools. */
    script?: string;
    headless: boolean;
    /**
     * Offer the controls inside the page's iframes (an embedded payment or
     * login form), and let the run's secrets be typed into the frames the
     * start page embeds. Off by default: every snapshot then reads each frame,
     * and a secret may reach an embedded third-party document.
     */
    iframes: boolean;
    /**
     * Run in the stealth browser by default (a run, a scenario or the UI form can ask per run):
     * patchright drives it, so no CDP Runtime domain a page can detect is enabled (sites behind
     * Kasada refuse the browser without it), and no OpenTelemetry script goes into the page. The
     * cost: no console messages are captured, and the trace has no browser spans.
     */
    stealth: boolean;
}

export interface FastConfig {
    engine: EngineConfig;
    text: TextConfig;
    daemon: DaemonConfig;
    ui: { host: string; port: number };
    /** Where scenarios are kept: `<dir>/<name>.json` (the prompts, committed). */
    scenarioDir: string;
    /** Where the recordings of passing runs are cached: `<dir>/<scenario>.json` (not committed). */
    cacheDir: string;
    /** Recordings kept per scenario, one per prompt (goal + start URL); the least recently used goes first. */
    cacheEntries: number;
    /** Where saved browser profiles are kept: `<dir>/<name>/` (never committed). */
    profileDir: string;
    /** IronBee platform reporting and trace reads (optional). */
    ironbee: IronBeeConfig;
    maxActions: number;
    maxDecisions: number;
}

function parseEnum<T extends string>(
    value: string | undefined,
    allowed: Record<string, T>,
    name: string,
    fallback: T
): T {
    if (value === undefined || value === "") {
        return fallback;
    }
    const match: T | undefined = Object.values(allowed).find((v: T): boolean => v === value.trim().toLowerCase());
    if (match === undefined) {
        throw new Error(`${name}=${value} is not one of ${Object.values(allowed).join(", ")}`);
    }
    return match;
}

export function parseEnumList<T extends string>(value: string, allowed: Record<string, T>, name: string): T[] {
    return value
        .split(",")
        .map((v: string): string => v.trim())
        .filter(Boolean)
        .map((v: string): T => parseEnum(v, allowed, name, undefined as unknown as T));
}

function parseInt10(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined || value === "") {
        return fallback;
    }
    const n: number = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`${name}=${value} is not a positive integer`);
    }
    return n;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined || value === "") {
        return fallback;
    }
    return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

/**
 * Each text-model provider's key (none = unavailable) and endpoint
 * (`*_BASE_URL` overrides it, e.g. a local OpenAI-compatible server); the CLI
 * providers' executables from PATH (`CLAUDE_CODE_CLI` / `CODEX_CLI` override).
 */
function providerSettings(env: NodeJS.ProcessEnv): Record<TextProvider, ProviderSettings> {
    return {
        [TextProvider.ANTHROPIC]: {
            apiKey: env.ANTHROPIC_API_KEY,
            baseUrl: env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URLS[TextProvider.ANTHROPIC],
        },
        [TextProvider.OPENAI]: {
            apiKey: env.OPENAI_API_KEY,
            baseUrl: env.OPENAI_BASE_URL ?? DEFAULT_BASE_URLS[TextProvider.OPENAI],
        },
        [TextProvider.OPENROUTER]: {
            apiKey: env.OPENROUTER_API_KEY,
            baseUrl: env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URLS[TextProvider.OPENROUTER],
        },
        [TextProvider.CLAUDE_CODE]: {
            baseUrl: "",
            command: env.CLAUDE_CODE_CLI ?? findOnPath("claude", env.PATH ?? ""),
        },
        [TextProvider.CODEX]: {
            baseUrl: "",
            command: env.CODEX_CLI ?? findOnPath("codex", env.PATH ?? ""),
        },
    };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FastConfig {
    return {
        engine: {
            kind: parseEnum(env.IBEXPRESS_ENGINE, EngineKind, "IBEXPRESS_ENGINE", EngineKind.JEV),
            jev: {
                apiKey: env.TYPESAFE_API_KEY ?? env.JEV_API_KEY,
                model: env.TYPESAFE_MODEL,
                url: env.TYPESAFE_URL,
            },
        },
        text: {
            candidates: env.IBEXPRESS_TEXT_CANDIDATES
                ? parseEnumList(env.IBEXPRESS_TEXT_CANDIDATES, CandidateKind, "IBEXPRESS_TEXT_CANDIDATES")
                : [CandidateKind.SUPPLIED, CandidateKind.QUOTED],
            model: parseTextModel(env.IBEXPRESS_TEXT_MODEL),
            providers: providerSettings(env),
        },
        daemon: {
            url: env.IRONBEE_DEVTOOLS_DAEMON_URL,
            port: parseInt10(env.IBEXPRESS_DAEMON_PORT, DEFAULT_DAEMON_PORT, "IBEXPRESS_DAEMON_PORT"),
            script: env.IRONBEE_DEVTOOLS_DAEMON_SCRIPT,
            headless: parseBool(env.IBEXPRESS_HEADLESS, true),
            iframes: parseBool(env.IBEXPRESS_IFRAMES, false),
            stealth: parseBool(env.IBEXPRESS_STEALTH, false),
        },
        ui: {
            host: env.IBEXPRESS_UI_HOST ?? "127.0.0.1",
            port: parseInt10(env.IBEXPRESS_UI_PORT, DEFAULT_UI_PORT, "IBEXPRESS_UI_PORT"),
        },
        // src/config or dist/config → the app's examples/scenarios.
        scenarioDir: env.IBEXPRESS_SCENARIO_DIR ?? join(__dirname, "..", "..", "examples", "scenarios"),
        cacheDir: env.IBEXPRESS_CACHE_DIR ?? join(process.cwd(), ".ibexpress", "cache"),
        cacheEntries: parseInt10(env.IBEXPRESS_CACHE_PER_SCENARIO, DEFAULT_CACHE_ENTRIES, "IBEXPRESS_CACHE_PER_SCENARIO"),
        profileDir: env.IBEXPRESS_PROFILE_DIR ?? join(process.cwd(), ".ibexpress", "profiles"),
        ironbee: resolveIronBeeConfig(env),
        maxActions: parseInt10(env.IBEXPRESS_MAX_ACTIONS, DEFAULT_MAX_ACTIONS, "IBEXPRESS_MAX_ACTIONS"),
        maxDecisions: parseInt10(env.IBEXPRESS_MAX_DECISIONS, DEFAULT_MAX_DECISIONS, "IBEXPRESS_MAX_DECISIONS"),
    };
}

/** Loads `<cwd>/.env` into the environment without overriding what is already set. */
export function loadDotEnv(file: string = ".env"): void {
    try {
        process.loadEnvFile(file);
    } catch {
        // No .env — the environment alone configures the run.
    }
}
