/**
 * A recorded control the page changed around — a price in the text beside it changed, twins
 * appeared beside it — is no longer named by its descriptor alone. Which of the controls with its
 * role and name it is now is a reading, not a rule: a number beside a control is sometimes a price
 * (volatile) and sometimes a model or an order (identity). So the decision engine is asked, in ONE
 * choice question, among the controls the page offers — or none. A pick it is not sure of counts as
 * none: the replay then diverges as before, and the engine may heal it.
 *
 * The engine picks an offered control id; nothing it says becomes a selector. What it reads is the
 * masked page the replay acts on (the caller's), the recording's descriptor (recorded off a masked
 * page) and the replayed history (secrets by name).
 */

import { HistoryEntry, Operation } from "../agent/policy";
import { SAME_CONTROL, SHORT_SAME_CONTROL } from "../agent/prompts";
import { Control, ControlSnapshot } from "../devtools/types";
import { ChoiceAnswer, ChoiceQuestion, SystemOneResponse, validateChoice } from "../engine/systemone";
import { DecisionEngine } from "../engine/types";
import { TargetDescriptor } from "./descriptor";

/** The option for "none of these". */
export const NO_CONTROL: string = "none";
/** How sure the engine must be of a control to act on it. */
export const MIN_SAME_CONTROL_PROBABILITY: number = 0.8;
/** Replayed steps the engine reads (the latest). */
const HISTORY_STEPS: number = 6;
const QUESTION: string = "same_control";

export interface Reidentified {
    /** The control the engine is sure is the recorded one; undefined when it is not (or none is). */
    control?: Control;
    /** The control the engine chose without being sure enough to act on it. */
    unsure?: Control;
    /** The engine's probability for its choice (a control or none); 0 when it could not be asked. */
    probability: number;
    /** How long the question took. */
    ms: number;
    /** Why the engine could not be asked (unreachable, a malformed answer). */
    error?: string;
}

/** Finds a changed control again; the replay's only engine question besides the goal judge's. */
export interface TargetReidentifier {
    reidentify(request: ReidentifyRequest): Promise<Reidentified>;
}

export interface ReidentifyRequest {
    operation: Operation;
    recorded: TargetDescriptor;
    /** Where the recorded step acted (its path). */
    recordedPath?: string;
    /** The controls of the recorded role and name on the page now (off the masked page). */
    candidates: Control[];
    /** The page now, masked. */
    page: ControlSnapshot;
    /** The steps replayed so far (secrets by name). */
    history: HistoryEntry[];
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The question and its state, as sent; exported for tests. */
export function sameControlRequest(
    goal: string,
    request: ReidentifyRequest,
    compact: boolean,
    maxOptions: number,
    maxTextChars: number
): { state: Record<string, unknown>; question: ChoiceQuestion; offered: Control[] } {
    const offered: Control[] = request.candidates.slice(0, Math.max(1, maxOptions - 1));
    // The candidates by id, then none (an object lists integer keys first whatever the order they are set in).
    const criteria: Record<string, unknown> = {};
    for (const c of offered) {
        criteria[String(c.id)] = { element: `[${c.id}] ${c.role} "${c.name}"`, ...(c.context !== undefined ? { context: c.context } : {}) };
    }
    criteria[NO_CONTROL] = "None of them: the recorded control is gone, or each of these belongs to a different item.";
    const recorded: Record<string, unknown> = {
        operation: request.operation,
        role: request.recorded.role,
        name: request.recorded.name,
        ...(request.recorded.context !== undefined ? { context_when_recorded: request.recorded.context } : {}),
        ...(request.recordedPath !== undefined ? { page_when_recorded: request.recordedPath } : {}),
    };
    const state: Record<string, unknown> = {
        ...(compact ? { goal } : {}),
        recorded,
        page: { title: request.page.title, url: request.page.url, text: clip(request.page.text, maxTextChars) },
        replayed_steps: request.history.slice(-HISTORY_STEPS).map((h: HistoryEntry): Record<string, unknown> => ({
            step: h.step,
            operation: h.operation,
            ...(h.target !== undefined ? { target: h.target } : {}),
            ...(h.text !== undefined ? { text: h.text } : {}),
            executed: h.executed,
        })),
    };
    const question: ChoiceQuestion = {
        type: "choice",
        criteria,
        instructions: compact ? SHORT_SAME_CONTROL : { goal, rules: SAME_CONTROL },
    };
    return { state, question, offered };
}

export class EngineReidentifier implements TargetReidentifier {
    constructor(
        private readonly engine: DecisionEngine,
        private readonly goal: string
    ) {}

    async reidentify(request: ReidentifyRequest): Promise<Reidentified> {
        const started: number = performance.now();
        const ms: () => number = (): number => Math.round(performance.now() - started);
        const { profile } = this.engine;
        const { state, question, offered } = sameControlRequest(this.goal, request, profile.compact, profile.maxOptions, profile.maxTextChars);
        try {
            const response: SystemOneResponse = await this.engine.ask(state, { [QUESTION]: question });
            const choice: ChoiceAnswer = validateChoice(response.answers?.[QUESTION], [NO_CONTROL, ...offered.map((c: Control): string => String(c.id))]);
            const probability: number = choice.probabilities[choice.choice] ?? 0;
            const chosen: Control | undefined = offered.find((c: Control): boolean => String(c.id) === choice.choice);
            if (chosen === undefined) {
                return { probability, ms: ms() };
            }
            return probability >= MIN_SAME_CONTROL_PROBABILITY ? { control: chosen, probability, ms: ms() } : { unsure: chosen, probability, ms: ms() };
        } catch (err: unknown) {
            // Not being able to ask is not the replay's failure: the step diverges as it would have.
            return { probability: 0, ms: ms(), error: err instanceof Error ? err.message : String(err) };
        }
    }
}
