/**
 * A deterministic stand-in for a decision engine: walks a fixed script,
 * finding each step's target by predicate on the current snapshot. When the
 * target is not there yet it WAITs (the page is loading) without advancing.
 */

import { Decider, Decision, DecisionInput, Operation, UserActionKind } from "../../src/agent/policy";
import { Control } from "../../src/devtools/types";

export interface ScriptStep {
    operation: Operation;
    target?: (c: Control) => boolean;
    textKey?: string;
    optionLabel?: string;
    /** ASK_USER: why. */
    userAction?: UserActionKind;
    /** PRESS_KEY: which key. */
    key?: string;
    /** SWITCH_TAB: which tab. */
    tab?: number;
    /** Only proceed once this holds (e.g. the URL changed). */
    when?: (input: DecisionInput) => boolean;
}

const BASE: Pick<Decision, "confidence" | "operationProbabilities" | "latencyMs"> = {
    confidence: 1,
    operationProbabilities: {},
    latencyMs: 0,
};

export class ScriptedDecider implements Decider {
    readonly seen: DecisionInput[] = [];
    private next: number = 0;

    constructor(private readonly script: ScriptStep[]) {}

    async decide(input: DecisionInput): Promise<Decision> {
        this.seen.push(input);
        const step: ScriptStep | undefined = this.script[this.next];
        if (!step) {
            return { ...BASE, operation: Operation.BLOCKED };
        }
        if (step.when && !step.when(input)) {
            return { ...BASE, operation: Operation.WAIT };
        }
        let target: Control | undefined;
        if (step.target) {
            target = input.snapshot.controls.find(step.target);
            if (!target) {
                return { ...BASE, operation: Operation.WAIT };
            }
        }
        this.next++;
        return {
            ...BASE,
            operation: step.operation,
            controlId: target?.id,
            textKey: step.textKey,
            userAction: step.userAction,
            key: step.key,
            tabIndex: step.tab,
            optionValue: step.optionLabel
                ? target?.options?.find((o: { label: string }): boolean => o.label === step.optionLabel)?.value
                : undefined,
        };
    }
}

export function named(name: string, context?: string): (c: Control) => boolean {
    return (c: Control): boolean => c.name === name && (context === undefined || (c.context ?? "").includes(context));
}
