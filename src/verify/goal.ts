/**
 * Where the goal stands, as the decision engine reads the evidence: DONE,
 * NOT_YET (still possible — a step missing, loading, a status in progress) or
 * FAILED (an error or failed outcome is shown that more steps will not fix).
 * Asked when the policy chooses DONE (on the page and the API responses) and
 * again at the end with the whole trace (analyzer.ts).
 *
 * The same request asks which piece of evidence — an API response, a log
 * record, a span, by the id it carries in the evidence — shows why the goal is
 * not done (`failure_cause`): the engine points at it, nothing here reads its
 * text. The judgement carries those as its signals, so a rejected DONE can say
 * WHY — the step decisions see only the page, and would otherwise choose the
 * same DONE again.
 */

import { GOAL_STATE, SHORT_GOAL_STATE } from "../agent/prompts";
import { ChoiceAnswer, ChoiceQuestion, RequestTooLargeError, SystemOneResponse, validateChoice } from "../engine/systemone";
import { DecisionEngine } from "../engine/types";
import { describeEvidence, EvidenceItem, evidenceItems, itemsIn } from "./describe";
import { GoalJudgement, GoalState, PageEvidence } from "./types";

/** At most this many chunks of evidence are read (small-context engines). */
const MAX_CHUNKS: number = 6;
const FULL_BUDGET_CHARS: number = 24_000;
/** Failure causes kept on a judgement, and how sure the engine must be of one. */
const MAX_SIGNALS: number = 3;
const MIN_CAUSE_PROBABILITY: number = 0.2;
const NO_CAUSE: string = "none";

const GOAL_STATES: string[] = Object.values(GoalState);

export function goalQuestion(goal: string, compact: boolean): ChoiceQuestion {
    return {
        type: "choice",
        instructions: compact ? `${SHORT_GOAL_STATE} Goal: ${goal}` : { goal, rules: GOAL_STATE },
        criteria: {
            [GoalState.DONE]: "Every part of the goal is done, and the evidence shows it.",
            [GoalState.NOT_YET]: "Not done yet but still possible: a step is missing, the page is loading, or a status is still in progress.",
            [GoalState.FAILED]: "Failed: the evidence shows an error or a failed outcome that more steps will not fix.",
        },
    };
}

/**
 * The evidence items the cause question offers: the first ones that fit beside `none` in the
 * engine's option cap. The question and its reader take this same list — an answer is validated
 * against exactly what was offered.
 */
export function offeredCauses(items: EvidenceItem[], maxOptions: number): EvidenceItem[] {
    return items.slice(0, Math.max(0, maxOptions - 1));
}

/**
 * Which piece of evidence shows why the goal is not done or went wrong: an option per offered API
 * response, log record and span, by the id it carries in the evidence (its content is read there,
 * not here). Undefined when nothing is offered.
 */
export function causeQuestion(goal: string, offered: EvidenceItem[]): ChoiceQuestion | undefined {
    if (offered.length === 0) {
        return undefined;
    }
    const criteria: Record<string, string> = { [NO_CAUSE]: "Nothing in the evidence shows the goal failing or going wrong." };
    for (const item of offered) {
        criteria[item.id] = `[${item.id}] ${item.label}`;
    }
    return {
        type: "choice",
        instructions: {
            goal,
            rules:
                "Which item of the evidence shows why the goal is not done or went wrong? Items are marked in the evidence: [r…] API responses (with their bodies), [l…] log records, [s…] spans. Pick none when nothing does.",
        },
        criteria,
    };
}

/** The labels of the offered items (`causeQuestion`'s list) the engine points at as the cause, likeliest first. */
export function readCauses(answer: unknown, offered: EvidenceItem[]): string[] {
    if (answer === undefined || offered.length === 0) {
        return [];
    }
    try {
        const choice: ChoiceAnswer = validateChoice(answer, [NO_CAUSE, ...offered.map((i: EvidenceItem): string => i.id)]);
        const byId: Map<string, string> = new Map(offered.map((i: EvidenceItem): [string, string] => [i.id, i.label]));
        return Object.entries(choice.probabilities)
            .filter(([id, p]: [string, number]): boolean => id !== NO_CAUSE && p >= MIN_CAUSE_PROBABILITY && p > (choice.probabilities[NO_CAUSE] ?? 0))
            .sort((a: [string, number], b: [string, number]): number => b[1] - a[1])
            .slice(0, MAX_SIGNALS)
            .map(([id]: [string, number]): string => byId.get(id)!);
    } catch {
        // No usable answer to this question: the goal's own answer still stands.
        return [];
    }
}

/** The engine's answer to `goalQuestion`, with the failure causes it pointed at. */
export function readGoalAnswer(answer: unknown, signals: string[]): GoalJudgement {
    const choice: ChoiceAnswer = validateChoice(answer, GOAL_STATES);
    const state: GoalState = choice.choice as GoalState;
    return {
        state,
        stateProbability: choice.probabilities[state],
        probability: choice.probabilities[GoalState.DONE] ?? 0,
        achieved: state === GoalState.DONE,
        ...(signals.length ? { signals } : {}),
    };
}

/** Splits text into chunks of at most `size` characters, on line boundaries where possible. */
export function chunkText(text: string, size: number): string[] {
    if (text.length <= size) {
        return [text];
    }
    const chunks: string[] = [];
    let current: string = "";
    for (const line of text.split("\n")) {
        if (current.length + line.length + 1 > size && current) {
            chunks.push(current);
            current = "";
        }
        current += (current ? "\n" : "") + line.slice(0, size);
    }
    if (current) {
        chunks.push(current);
    }
    return chunks;
}

/** Evidence too large for the engine is sent again with this share of it (and of the cause options). */
const SHRINK_SHARES: number[] = [1, 0.5, 0.25];

/**
 * Asks with the whole budget and, when the request is larger than the engine takes, again with a
 * smaller share of the evidence — a judgement changes nothing, so asking again is safe.
 */
export async function askShrinking<T>(ask: (share: number) => Promise<T>): Promise<T> {
    for (let i: number = 0; ; i++) {
        try {
            return await ask(SHRINK_SHARES[i]);
        } catch (err: unknown) {
            if (!(err instanceof RequestTooLargeError) || i === SHRINK_SHARES.length - 1) {
                throw err;
            }
        }
    }
}

/** The evidence budget an engine takes per request. */
export function evidenceBudget(engine: DecisionEngine): number {
    return engine.profile.compact ? engine.profile.maxTextChars : Math.max(engine.profile.maxTextChars, FULL_BUDGET_CHARS);
}

export class GoalJudge {
    constructor(private readonly engine: DecisionEngine) {}

    /**
     * One request for a large-context engine, its evidence within the budget. A small (compact)
     * one reads a larger evidence in chunks of its budget: DONE in any chunk wins, else FAILED in
     * any, else NOT_YET.
     */
    async judge(goal: string, evidence: PageEvidence): Promise<GoalJudgement> {
        return askShrinking((share: number): Promise<GoalJudgement> => this.judgeWith(goal, evidence, share));
    }

    private async judgeWith(goal: string, evidence: PageEvidence, share: number): Promise<GoalJudgement> {
        const budget: number = Math.floor(evidenceBudget(this.engine) * share);
        const compact: boolean = this.engine.profile.compact;
        const chunks: string[] = compact
            ? chunkText(describeEvidence(evidence, budget * MAX_CHUNKS), budget).slice(0, MAX_CHUNKS)
            : [describeEvidence(evidence, budget)];
        const items: EvidenceItem[] = evidenceItems(evidence);
        const maxCauses: number = Math.max(10, Math.floor(this.engine.profile.maxOptions * share));
        let verdict: GoalJudgement | undefined;
        for (const chunk of chunks) {
            // Only what this request's evidence carries can be pointed at: per chunk, so a chunk is
            // never offered an item another chunk holds.
            const offered: EvidenceItem[] = offeredCauses(itemsIn(items, chunk), maxCauses);
            const cause: ChoiceQuestion | undefined = causeQuestion(goal, offered);
            const response: SystemOneResponse = await this.engine.ask(
                { evidence: chunk },
                { goal_state: goalQuestion(goal, this.engine.profile.compact), ...(cause ? { failure_cause: cause } : {}) }
            );
            const judged: GoalJudgement = readGoalAnswer(response.answers?.goal_state, readCauses(response.answers?.failure_cause, offered));
            if (judged.achieved) {
                return judged;
            }
            if (!verdict || (judged.state === GoalState.FAILED && verdict.state !== GoalState.FAILED)) {
                verdict = judged;
            }
        }
        return verdict!;
    }
}
