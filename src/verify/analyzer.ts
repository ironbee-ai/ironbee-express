/**
 * The review of a finished run, in ONE decision engine request: whether the
 * goal is done (with the whole trace now), and for each anomaly the evidence
 * shows (candidates.ts) how much of a problem it is for that goal — none,
 * minor, major or critical. The verdict follows: passed when the goal is done
 * and nothing major or critical went wrong.
 */

import { ISSUE } from "../agent/prompts";
import { ChoiceAnswer, ChoiceQuestion, SystemOneResponse, validateChoice } from "../engine/systemone";
import { DecisionEngine } from "../engine/types";
import { collectCandidates } from "./candidates";
import { describeEvidence, EvidenceItem, evidenceItems, itemsIn } from "./describe";
import { askShrinking, causeQuestion, evidenceBudget, goalQuestion, offeredCauses, readCauses, readGoalAnswer } from "./goal";
import { Candidate, Finding, GoalJudgement, GoalState, PageEvidence, RunAnalysis, Severity, Verdict } from "./types";

const SEVERITY_CRITERIA: Record<Severity, string> = {
    [Severity.NONE]: "Not a problem: expected for this flow, or harmless.",
    [Severity.MINOR]: "Minor: noise, a warning or a cosmetic error; the goal and its data are not affected.",
    [Severity.MAJOR]: "Major: a real bug or failure that affects the flow or its data, though the goal's main result happened.",
    [Severity.CRITICAL]: "Critical: the goal's main result failed or is wrong (the main operation failed, was not saved, or was saved wrong).",
};

const RANK: Record<Severity, number> = {
    [Severity.NONE]: 0,
    [Severity.MINOR]: 1,
    [Severity.MAJOR]: 2,
    [Severity.CRITICAL]: 3,
};

export function issueQuestion(goal: string, candidate: Candidate): ChoiceQuestion {
    return {
        type: "choice",
        criteria: { ...SEVERITY_CRITERIA },
        instructions: { goal, anomaly: `${candidate.title} — ${candidate.detail}`, source: candidate.source, rules: ISSUE },
    };
}

/** The verdict and its one-line reason, from the goal judgement and the findings. */
export function decideVerdict(
    goalDone: boolean,
    runReachedDone: boolean,
    findings: Finding[],
    causes: string[] = []
): { verdict: Verdict; summary: string } {
    const serious: Finding[] = findings.filter((f: Finding): boolean => RANK[f.severity] >= RANK[Severity.MAJOR]);
    // Why: the evidence the engine pointed at, else the worst finding.
    const why: string | undefined = causes[0] ?? serious[0]?.title;
    if (!runReachedDone) {
        return {
            verdict: Verdict.FAILED,
            summary: why ? `the goal was not reached: ${why}` : "the run did not reach the goal",
        };
    }
    if (!goalDone) {
        return {
            verdict: Verdict.FAILED,
            summary: why ? `the goal is not done: ${why}` : "the evidence does not show the goal done",
        };
    }
    if (serious.length) {
        return { verdict: Verdict.FAILED, summary: `${serious[0].severity}: ${serious[0].title}` };
    }
    const minor: number = findings.length;
    return { verdict: Verdict.PASSED, summary: minor ? `goal done; ${minor} minor issue${minor === 1 ? "" : "s"}` : "goal done; no problems found" };
}

export class RunAnalyzer {
    constructor(private readonly engine: DecisionEngine) {}

    /**
     * The engine's review of the run's evidence.
     *
     * `runReachedDone`: the run ended DONE (a blocked or budget-exhausted run
     * failed whatever the evidence shows; its findings still say why).
     * `confirmedBy`: the text model that had the controls confirmed the goal done where the engine
     * could not see it (a state shown only by styling); the goal counts as done on its word.
     */
    async analyze(
        goal: string,
        evidence: PageEvidence,
        runReachedDone: boolean,
        confirmedBy?: { model: string; why: string }
    ): Promise<RunAnalysis> {
        const analysis: RunAnalysis = await askShrinking(
            (share: number): Promise<RunAnalysis> => this.analyzeWith(goal, evidence, runReachedDone, share)
        );
        if (!confirmedBy || analysis.goal.achieved) {
            return analysis;
        }
        const judged: GoalJudgement = { ...analysis.goal, state: GoalState.DONE, achieved: true, confirmedBy };
        return { ...analysis, ...decideVerdict(true, runReachedDone, analysis.findings), goal: judged };
    }

    /** The review with `share` of the evidence budget and of the cause options (a request too large asks again with less). */
    private async analyzeWith(goal: string, evidence: PageEvidence, runReachedDone: boolean, share: number): Promise<RunAnalysis> {
        const candidates: Candidate[] = collectCandidates(evidence);
        const questions: Record<string, ChoiceQuestion> = {
            goal_state: goalQuestion(goal, this.engine.profile.compact),
        };
        candidates.forEach((c: Candidate, i: number): void => {
            questions[`issue_${i}`] = issueQuestion(goal, c);
        });
        // The evidence fits the budget as it is described; only the items it carries are offered.
        const described: string = describeEvidence(evidence, Math.floor(evidenceBudget(this.engine) * share));
        const offered: EvidenceItem[] = offeredCauses(
            itemsIn(evidenceItems(evidence), described),
            Math.max(10, Math.floor(this.engine.profile.maxOptions * share))
        );
        const cause: ChoiceQuestion | undefined = causeQuestion(goal, offered);
        if (cause) {
            questions.failure_cause = cause;
        }
        const response: SystemOneResponse = await this.engine.ask({ evidence: described }, questions);

        const severities: string[] = Object.values(Severity);
        const findings: Finding[] = candidates
            .map((c: Candidate, i: number): Finding => {
                const answer: ChoiceAnswer = validateChoice(response.answers?.[`issue_${i}`], severities);
                return { ...c, severity: answer.choice as Severity, probability: answer.probabilities[answer.choice] };
            })
            .filter((f: Finding): boolean => f.severity !== Severity.NONE)
            .sort((a: Finding, b: Finding): number => RANK[b.severity] - RANK[a.severity] || b.probability - a.probability);
        // Why the goal is not done: the evidence the engine points at, else its worst findings.
        const causes: string[] = readCauses(response.answers?.failure_cause, offered);
        const judged: GoalJudgement = readGoalAnswer(
            response.answers?.goal_state,
            causes.length ? causes : findings.map((f: Finding): string => f.title).slice(0, 3)
        );
        return {
            ...decideVerdict(judged.achieved, runReachedDone, findings, causes),
            goal: judged,
            findings,
            candidates: candidates.length,
        };
    }
}
