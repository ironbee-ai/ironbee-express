/**
 * The System One wire protocol (`POST /v1/systemone`): a state plus typed
 * questions in, a typed answer per question out. TypeSafe Jev defined it; any
 * engine that speaks the same protocol can reuse this client.
 */

import { pooledFetch, warmUp } from "../net/http";

/** Busy, and transient server errors: a decision request changes nothing, so asking again is safe. */
const RETRY_STATUSES: Set<number> = new Set([429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS: number = 3;
const DEFAULT_TIMEOUT_MS: number = 25_000;
/** Probabilities are allowed to drift from summing to 1 by this much. */
const PROBABILITY_SUM_TOLERANCE: number = 0.02;

export interface ChoiceQuestion {
    type: "choice";
    criteria: Record<string, unknown>;
    instructions: unknown;
}

/** The one kind of question this client asks (the wire protocol also has `noul`, which nothing here sends). */
export type Question = ChoiceQuestion;

export interface ChoiceAnswer {
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
}

export interface SystemOneResponse {
    model?: string;
    answers: Record<string, unknown>;
    usage?: { input_tokens?: number; output_tokens?: number };
}

export class DecisionEngineError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DecisionEngineError";
    }
}

/** The request is larger than the engine takes (its `max_tokens_exceeded` error): asking with less may work. */
export class RequestTooLargeError extends DecisionEngineError {
    constructor(message: string) {
        super(message);
        this.name = "RequestTooLargeError";
    }
}

/** Whether an error body is the engine's "request too large" (`{"detail": {"error_type": "max_tokens_exceeded"}}`). */
function isTooLarge(body: string): boolean {
    try {
        const parsed: { detail?: { error_type?: unknown } } = JSON.parse(body) as { detail?: { error_type?: unknown } };
        return parsed.detail?.error_type === "max_tokens_exceeded";
    } catch {
        return false;
    }
}

/** The engine answered, but not in a shape that can be acted on: nothing was executed, so asking again is safe. */
export class InvalidAnswerError extends DecisionEngineError {
    constructor(message: string) {
        super(message);
        this.name = "InvalidAnswerError";
    }
}

export interface SystemOneClientOptions {
    /** Full endpoint URL, e.g. https://api.typesafe.ai/v1/systemone. */
    url: string;
    /** Sent as a bearer token when set. */
    apiKey?: string;
    /** Sent as `model` when set. */
    model?: string;
    timeoutMs?: number;
    /** Name used in error messages. */
    label: string;
    fetchImpl?: typeof fetch;
}

export class SystemOneClient {
    constructor(private readonly options: SystemOneClientOptions) {}

    /** Opens the connection before the first question (a no-op with an injected fetch). */
    warmUp(): void {
        if (!this.options.fetchImpl) {
            warmUp(this.options.url);
        }
    }

    async ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
        const doFetch: typeof fetch = this.options.fetchImpl ?? pooledFetch;
        const body: string = JSON.stringify({
            ...(this.options.model ? { model: this.options.model } : {}),
            state,
            questions,
        });
        const headers: Record<string, string> = {
            "content-type": "application/json",
        };
        if (this.options.apiKey) {
            headers.authorization = `Bearer ${this.options.apiKey}`;
        }
        const label: string = this.options.label;
        for (let attempt: number = 1; ; attempt++) {
            let response: Response;
            try {
                response = await doFetch(this.options.url, {
                    method: "POST",
                    headers,
                    body,
                    signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
                });
            } catch {
                // A dropped or refused connection is as passing as a 503: a question changes nothing, ask again.
                if (attempt < MAX_ATTEMPTS) {
                    await new Promise<void>((resolve: () => void): void => {
                        setTimeout(resolve, 500 * 2 ** (attempt - 1));
                    });
                    continue;
                }
                throw new DecisionEngineError(
                    `${label}: connection to ${this.options.url} failed; no action executed`
                );
            }
            if (RETRY_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
                await new Promise<void>((resolve: () => void): void => {
                    setTimeout(resolve, 500 * 2 ** (attempt - 1));
                });
                continue;
            }
            if (!response.ok) {
                const body: string = await response.text();
                const message: string = `${label}: HTTP ${response.status} ${body.slice(0, 300)}; no action executed`;
                throw isTooLarge(body) ? new RequestTooLargeError(message) : new DecisionEngineError(message);
            }
            return (await response.json()) as SystemOneResponse;
        }
    }
}

/**
 * Accepts an answer only when it chose an offered option, gave a probability
 * for exactly the offered options, the probabilities are finite, in [0, 1],
 * sum to ~1, and the choice is the most probable one.
 */
export function validateChoice(answer: unknown, options: readonly string[]): ChoiceAnswer {
    const a: any = answer;
    const offered: Set<string> = new Set(options);
    const valid: boolean = ((): boolean => {
        if (!a || typeof a !== "object") {return false;}
        if (typeof a.choice !== "string" || !offered.has(a.choice)) {return false;}
        const probabilities: unknown = a.probabilities;
        if (!probabilities || typeof probabilities !== "object") {return false;}
        const keys: string[] = Object.keys(probabilities);
        if (keys.length !== offered.size || !keys.every((k: string): boolean => offered.has(k))) {
            return false;
        }
        const values: unknown[] = [...Object.values(probabilities), a.confidence];
        if (!values.every((n: unknown): boolean => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)) {
            return false;
        }
        const p: Record<string, number> = probabilities as Record<string, number>;
        const sum: number = keys.reduce((s: number, k: string): number => s + p[k], 0);
        if (Math.abs(sum - 1) >= PROBABILITY_SUM_TOLERANCE) {return false;}
        return p[a.choice] >= Math.max(...keys.map((k: string): number => p[k])) - 1e-6;
    })();
    if (!valid) {
        throw new InvalidAnswerError("Invalid choice answer; no action executed");
    }
    return {
        choice: a.choice,
        probabilities: a.probabilities,
        confidence: a.confidence,
    };
}
