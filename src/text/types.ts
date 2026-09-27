/**
 * Where typed text comes from. Two independent axes:
 *
 * - candidate sources contribute a fixed list of values the decision engine
 *   CHOOSES from (it never writes text);
 * - an optional text model — an API or CLI provider (providers.ts) — WRITES a value when no candidate fits.
 */

export enum TextSource {
    /** A value the caller supplied; its text may be shown to the engine. */
    VALUE = "value",
    /** A value the caller supplied as secret; only its name is ever shown. */
    SECRET = "secret",
    /** A quoted literal in the goal. */
    GOAL_LITERAL = "goal-literal",
    /** A value cut out of the goal (no longer offered; kept so older recordings still replay). */
    GOAL_SPAN = "goal-span",
    /** Written by the configured text model. */
    GENERATE = "generate",
    /** Written by the text model while it had the controls (agent/rescue.ts): a literal it typed, never a secret. */
    TAKEOVER = "takeover",
    /** Typed by the person running the test, when nothing else fits (the run pauses for it). */
    USER = "user",
    /**
     * The text a field already held from this run, joined with a new value: the field is the one
     * place for several parts of the goal (see Agent.settleFieldText). Its parts are kept.
     */
    COMBINED = "combined",
}

export interface TextChoice {
    key: string;
    source: TextSource;
    /** VALUE / SECRET: the name the caller supplied it under (its key is `value:<name>` / `secret:<name>`). */
    name?: string;
    /** What the engine sees for this choice. Never contains a secret. */
    description: string;
    /** The text to type; absent for GENERATE (and stripped before the engine sees choices). */
    text?: string;
}

/** A supplied value's or secret's name: what a key, a `{{secret:…}}` reference and a recording carry. */
export const VALUE_NAME: RegExp = /^[A-Za-z0-9_.-]{1,60}$/;

/** The name as supplied, or why it cannot be one (letters, digits, `.`, `-`, `_`; up to 60). */
export function validateValueName(name: string, what: string = "value"): string {
    if (!VALUE_NAME.test(name)) {
        throw new Error(`${what} name ${JSON.stringify(name)} must be 1-60 letters, digits, ".", "-" or "_"`);
    }
    return name;
}

/**
 * Where a typed value came from, as a recording keeps it: a supplied value or
 * secret by NAME (resolved again from the run's values on replay, so they can
 * change), anything else by its text. A secret's text is never kept.
 */
export interface TextRef {
    source: TextSource;
    /** VALUE / SECRET: the name the caller supplied it under. */
    name?: string;
    /** Every source but SECRET: the text typed (a fallback for a VALUE). */
    text?: string;
    /** COMBINED: the parts, in order, each resolved again on replay and joined with `separator`. */
    parts?: TextRef[];
    /** COMBINED: what joins the parts. */
    separator?: string;
}

export enum CandidateKind {
    SUPPLIED = "supplied",
    QUOTED = "quoted",
}

/** Contributes candidates for one run. */
export interface TextCandidateSource {
    readonly kind: CandidateKind;
    candidates(goal: string): Array<Omit<TextChoice, "key">>;
}

export interface FieldContext {
    goal: string;
    field: { name: string; role: string; value?: string };
    page: { title: string; text: string };
    recentActions: Array<{ operation: string; target?: string; text?: string }>;
}

/** Writes one field value. Returns null when it has no confident value — nothing is typed then. */
export interface TextGenerator {
    /** `provider/model`. */
    readonly label: string;
    generate(context: FieldContext): Promise<string | null>;
}

/** The text setup of one run: the choices offered and the generator behind GENERATE. */
export interface TextStrategy {
    choices: TextChoice[];
    generator?: TextGenerator;
    /** Secret values by name, for masking. */
    secrets: Record<string, string>;
    /**
     * DevTools holds the run's secrets (every one is typed by `{{secret:…}}` reference and masked at
     * the source). False when this process types the values itself: what DevTools returns may then
     * carry one in a form this process's masking does not cover (a base64 `Authorization` header).
     * Absent = false.
     */
    secretsInDevtools?: boolean;
}
