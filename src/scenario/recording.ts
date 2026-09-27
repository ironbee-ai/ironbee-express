/**
 * Turns a passed run's steps into a recording: only executed actions, WAITs
 * dropped (a replay waits for its target instead), and repeated typing into
 * the same field collapsed to the last value.
 */

import { StepEvent } from "../agent/agent";
import { Operation } from "../agent/policy";
import { pathOf as pathOfUrl } from "../util/url";
import { TargetDescriptor } from "./descriptor";
import { RecordedStep } from "./types";

/** The operations a recording keeps — every one a replay can carry out. */
export const RECORDED: Set<Operation> = new Set([
    Operation.CLICK,
    Operation.TYPE_TEXT,
    Operation.SELECT,
    Operation.PRESS_ENTER,
    Operation.SCROLL_DOWN,
    Operation.SCROLL_UP,
    Operation.ASK_USER,
    Operation.HOVER,
    Operation.PRESS_KEY,
    Operation.GO_BACK,
    Operation.GO_FORWARD,
    Operation.SWITCH_TAB,
    Operation.CLOSE_TAB,
]);

/** The recorded operations that act on a control: a step of one always carries its target. */
export const TARGETED: Set<Operation> = new Set([Operation.CLICK, Operation.TYPE_TEXT, Operation.SELECT, Operation.PRESS_ENTER, Operation.HOVER]);

function sameTarget(a?: TargetDescriptor, b?: TargetDescriptor): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** The step's page path, when its URL parses (a step of an unparseable URL records none). */
function pathOf(url: string): string | undefined {
    return URL.canParse(url) ? pathOfUrl(url) : undefined;
}

export function recordSteps(steps: StepEvent[]): RecordedStep[] {
    const out: RecordedStep[] = [];
    for (const step of steps) {
        if (!step.executed || !RECORDED.has(step.operation)) {
            continue;
        }
        if (TARGETED.has(step.operation) && !step.targetDescriptor) {
            // Not replayable without its target; the replay will hand this part to the engine.
            continue;
        }
        const path: string | undefined = pathOf(step.url);
        const recorded: RecordedStep = {
            operation: step.operation,
            ...(step.targetDescriptor ? { target: step.targetDescriptor } : {}),
            ...(step.textRef ? { text: step.textRef } : {}),
            ...(step.optionLabel ? { optionLabel: step.optionLabel } : {}),
            ...(step.key ? { key: step.key } : {}),
            ...(step.tab !== undefined ? { tab: step.tab } : {}),
            ...(step.tabUrl ? { tabUrl: step.tabUrl } : {}),
            ...(step.userAction ? { userAction: step.userAction.kind } : {}),
            ...(path !== undefined ? { path } : {}),
        };
        const last: RecordedStep | undefined = out[out.length - 1];
        if (
            last &&
            last.operation === Operation.TYPE_TEXT &&
            recorded.operation === Operation.TYPE_TEXT &&
            sameTarget(last.target, recorded.target)
        ) {
            out[out.length - 1] = recorded;
            continue;
        }
        out.push(recorded);
    }
    return out;
}
