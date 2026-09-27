/** A decision engine that records every request and answers through a callback. */

import { Question, SystemOneResponse } from "../../src/engine/systemone";
import { DecisionEngine, EngineHealth, EngineKind, EngineProfile } from "../../src/engine/types";
import { JEV_PROFILE } from "../../src/engine/jev";

export interface RecordedRequest {
    state: unknown;
    questions: Record<string, Question>;
}

export class FakeEngine implements DecisionEngine {
    readonly kind: EngineKind = EngineKind.JEV;
    readonly label: string = "fake";
    readonly requests: RecordedRequest[] = [];

    constructor(
        private readonly respond: (request: RecordedRequest) => Record<string, unknown>,
        readonly profile: EngineProfile = JEV_PROFILE
    ) {}

    async ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
        const request: RecordedRequest = { state, questions };
        this.requests.push(request);
        return { model: "fake", answers: this.respond(request) };
    }

    async health(): Promise<EngineHealth> {
        return { ok: true, detail: "fake" };
    }
}
