import type { BrowserToolSessionContext, Tool, ToolInput, ToolInputSchema, ToolOutput, ToolOutputSchema } from "./host";
import {
    ControlSnapshot,
    controlSnapshotLimitsShape,
    controlSnapshotShape,
    DEFAULT_MAX_CONTROLS,
    DEFAULT_MAX_TEXT_CHARS,
    takeControlSnapshot,
} from "./snapshot";

export interface TakeSnapshotInput extends ToolInput {
    maxControls?: number;
    maxTextChars?: number;
}

export interface TakeSnapshotOutput extends ToolOutput, ControlSnapshot {}

export class TakeSnapshot implements Tool {
    name(): string {
        return "control_take-snapshot";
    }

    description(): string {
        return "Fast one-call snapshot for agent loops: visible text plus the visible, enabled controls in the viewport, each with a stable id, role, name, current value/state and the operations it supports. Act on them with <control_act>. Password fields are offered, their values never read.";
    }

    inputSchema(): ToolInputSchema {
        return controlSnapshotLimitsShape();
    }

    outputSchema(): ToolOutputSchema {
        return controlSnapshotShape();
    }

    async handle(
        context: BrowserToolSessionContext,
        args: TakeSnapshotInput
    ): Promise<TakeSnapshotOutput> {
        const snapshot: ControlSnapshot = await takeControlSnapshot(context, {
            maxControls: args.maxControls ?? DEFAULT_MAX_CONTROLS,
            maxTextChars: args.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
        });
        return { ...snapshot };
    }
}
