/**
 * A scenario: what to do (goal, start URL, values — the prompt). How a passing
 * run of it did it (the recording) is kept apart, in the recording cache.
 * Replaying a recording needs no decision engine; the engine still reviews the outcome.
 */

import { Operation, UserActionKind } from "../agent/policy";
import { CandidateKind, TextRef } from "../text/types";
import { TargetDescriptor } from "./descriptor";

export const SCENARIO_FORMAT_VERSION: number = 1;

export interface RecordedStep {
    operation: Operation;
    target?: TargetDescriptor;
    text?: TextRef;
    /** SELECT: the option by its label. */
    optionLabel?: string;
    /** PRESS_KEY: the key. */
    key?: string;
    /** SWITCH_TAB: the tab's index at record time (a fallback: indexes shift as tabs close). */
    tab?: number;
    /** SWITCH_TAB: the tab's address (origin + path) — how a replay finds it. */
    tabUrl?: string;
    /** ASK_USER: why the run handed the browser to its user (a replay pauses again). */
    userAction?: UserActionKind;
    /** Path of the page the step acted on, for reading and diagnostics. */
    path?: string;
}

export interface Recording {
    /** Hash of goal + start URL: an edited prompt invalidates the recording. */
    promptHash: string;
    recordedAt: string;
    /** The engine that explored (or healed) it. */
    engine: string;
    steps: RecordedStep[];
    /** The run's time when recorded. */
    elapsedMs: number;
    /** Set when a replay diverged and the engine repaired the rest. */
    healedAt?: string;
}

export interface Scenario {
    formatVersion: number;
    name: string;
    description?: string;
    goal: string;
    url?: string;
    /** Plain values; supplied again at run time they override these. */
    values: Record<string, string>;
    /** Secrets are never stored: only their names, to be supplied at run time. */
    secretNames: string[];
    /** Of `secretNames`, the login passwords: typed into password inputs only, never into another site's frame. */
    passwordSecrets?: string[];
    /** What each value / secret is for, by name (optional). */
    descriptions?: Record<string, string>;
    textCandidates?: CandidateKind[];
    /** `provider/model` that writes a value when none fits; absent = none. */
    textModel?: string;
    /** The saved browser profile its runs use (logins kept between runs); absent = a fresh browser. */
    profile?: string;
    createdAt: string;
    updatedAt: string;
}

/** How a run was carried out. */
export enum RunMode {
    /** The engine decided every step. */
    EXPLORE = "explore",
    /** A recording was replayed end to end; no engine decisions. */
    REPLAY = "replay",
    /** A recording was replayed until it diverged; the engine finished the run. */
    REPLAY_HEALED = "replay-healed",
}
