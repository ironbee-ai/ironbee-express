/**
 * The run is judged by the decision engine, not by rules the user writes:
 * whether the goal was reached (at DONE, and again at the end with the whole
 * trace), and which of the run's anomalies — failed or 4xx/5xx requests,
 * console errors, failed or slow spans, warning and error logs — are real
 * problems for that goal. No body or message text is matched against words
 * here: the engine reads it.
 */

import { Control } from "../devtools/types";

import { Journey } from "./journey";

/** One request the page made, as DevTools captured it. */
export interface CapturedRequest {
    method: string;
    url: string;
    resourceType: string;
    status?: number;
    /** Network failure (no response). */
    failure?: string;
    /** Response body (text), possibly clipped. */
    body?: string;
    /** Request body (text) as sent, possibly clipped; credentials redacted by DevTools. */
    requestBody?: string;
    /** Request headers (credentials redacted by DevTools). */
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    timestamp: number;
}

export interface ConsoleEntry {
    type: string;
    text: string;
    timestamp: number;
}

export interface TraceSpanRecord {
    spanId: string;
    parentSpanId?: string;
    name: string;
    service?: string;
    kind?: string;
    status?: string;
    statusMessage?: string;
    durationMs: number;
    attributes?: Record<string, unknown>;
}

export interface TraceLogRecord {
    service?: string;
    severityNumber?: number;
    body: string;
    timeNs?: string;
    spanId?: string;
}

export interface TraceEvidence {
    traceId: string;
    spanCount: number;
    /** Every span read, start order. */
    spans: TraceSpanRecord[];
    /** The trace's log records, time order. */
    logs: TraceLogRecord[];
    /** Services with span / failed-span counts. */
    services: Array<{ name: string; spanCount: number; errorCount: number }>;
}

export interface PageEvidence {
    url: string;
    title: string;
    /** The whole page's text. */
    text: string;
    /** When the evidence was read, with the weekday: what "tomorrow" or "next Friday" in a goal means. */
    now?: string;
    /** What the screen shows now (the viewport's text): where the page stands, whatever its length. */
    visibleText?: string;
    /** The page's controls with their state (checked, selected, value …): a page's text does not say them. */
    controls?: Control[];
    /** App requests (fetch / xhr) during the run, oldest first. */
    requests?: CapturedRequest[];
    /** Console errors and uncaught exceptions during the run. */
    consoleErrors?: ConsoleEntry[];
    /** The run's trace on the IronBee platform. */
    trace?: TraceEvidence;
    /** The steps taken and the pages visited before this one (secrets masked). */
    journey?: Journey;
}

/** Where the goal stands, as the engine reads the evidence. */
export enum GoalState {
    /** Every part of the goal is done, and the evidence shows it. */
    DONE = "done",
    /** Not done yet, but still possible: steps missing, loading, a status in progress. */
    NOT_YET = "not-yet",
    /** Failed, and more steps will not fix it: an error or a failed outcome is shown. */
    FAILED = "failed",
}

/** Whether the engine sees the goal reached on the evidence. */
export interface GoalJudgement {
    state: GoalState;
    /** The engine's probability of that state. */
    stateProbability: number;
    /** Probability the goal is done (the DONE option's). */
    probability: number;
    achieved: boolean;
    /** Failure signals the evidence shows (anomaly titles, likeliest first): the "why" of NOT_YET / FAILED. */
    signals?: string[];
    /** The goal was confirmed done by the text model that had the controls (the engine could not see it). */
    confirmedBy?: { model: string; why: string };
}

/** Where a finding was seen. */
export enum FindingSource {
    NETWORK = "network",
    CONSOLE = "console",
    TRACE = "trace",
    LOG = "log",
}

export enum Severity {
    /** Expected for the flow or harmless. Never reported. */
    NONE = "none",
    MINOR = "minor",
    MAJOR = "major",
    CRITICAL = "critical",
}

/** A request a finding rests on (the UI marks it). */
export interface RequestRef {
    method: string;
    url: string;
    timestamp: number;
}

export enum TraceItemKind {
    SPAN = "span",
    LOG = "log",
}

/** A span (by id) or log record (by `logKey`) a finding rests on. */
export interface TraceRef {
    kind: TraceItemKind;
    id: string;
}

/** One place an anomaly was seen, kept apart for the UI (the engine reads `detail`). */
export interface Occurrence {
    source: FindingSource;
    /** `GET /api/orders/*`, `order-service`, `order-service: POST /charge`, `console`. */
    where: string;
    /** `→ 500`, the log line or console message. */
    what: string;
    count: number;
    /** The start of a response body, when one was read. */
    excerpt?: string;
}

/** An anomaly worth asking about, found mechanically in the evidence. */
export interface Candidate {
    source: FindingSource;
    /** One line: `POST /api/items → 500`, `worker-service: JOB_FAILED 42`. */
    title: string;
    /** What was seen, for the engine and the report: a count, a body excerpt, a message. */
    detail: string;
    /** Where it was seen, one entry per place. */
    occurrences?: Occurrence[];
    requests?: RequestRef[];
    trace?: TraceRef[];
}

/** A candidate the engine judged to be a problem. */
export interface Finding extends Candidate {
    severity: Severity;
    /** The engine's probability of that severity. */
    probability: number;
}

export enum Verdict {
    /** The goal was reached and nothing major or critical went wrong. */
    PASSED = "passed",
    FAILED = "failed",
}

/** A text model's words on why a run failed (explain.ts): it explains the verdict, never changes it. */
export interface Explanation {
    /** `provider/model`. */
    model: string;
    text: string;
    ms: number;
}

/** The engine's review of a finished run. */
export interface RunAnalysis {
    verdict: Verdict;
    /** One line: why the verdict. */
    summary: string;
    goal: GoalJudgement;
    /** Problems only (severity above NONE), most severe first. */
    findings: Finding[];
    /** How many anomalies were considered. */
    candidates: number;
    /** A failed run's explanation by the text model, once it answered (it comes after the verdict). */
    explanation?: Explanation;
    /** Why there is no explanation although one was asked for. */
    explanationError?: string;
}
