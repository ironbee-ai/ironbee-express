/**
 * A decision engine answers typed questions (choice) about a state.
 * The policy and the verifier are written against this interface only; which
 * engine runs is configuration.
 */

import { Question, SystemOneResponse } from "./systemone";

export enum EngineKind {
    /** TypeSafe Jev, hosted. */
    JEV = "jev",
}

/**
 * How requests must be shaped for an engine. Jev takes a 32k-token state and
 * up to 255 options; a small-context engine packs every option of a question into a short
 * head and the state into 512–1024 tokens, so the policy shortlists, clips
 * and moves the goal out of the (truncated) instructions.
 */
export interface EngineProfile {
    /** Options offered per choice question; the rest are shortlisted away. */
    maxOptions: number;
    /** Characters of page text sent in the state. */
    maxTextChars: number;
    /** Characters per option label. */
    maxLabelChars: number;
    /** Elements listed in the state (they also appear as options). */
    maxStateElements: number;
    /**
     * Short instructions, goal in the state: for engines that truncate the
     * instructions to fit the options.
     */
    compact: boolean;
}

export interface DecisionEngine {
    readonly kind: EngineKind;
    /** Human-readable, e.g. "jev (jev-latest)". */
    readonly label: string;
    readonly profile: EngineProfile;
    ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse>;
    /** Opens the connection ahead of the first question, while the page loads; optional. */
    warmUp?(): void;
    /** Whether the engine is reachable and configured; never throws. */
    health(): Promise<EngineHealth>;
}

export interface EngineHealth {
    ok: boolean;
    detail: string;
}
