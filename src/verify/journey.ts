/**
 * The run so far, for whoever judges the goal: the steps taken and the pages
 * visited. The final page alone cannot show a goal whose parts happened
 * elsewhere ("find the order total, then go back"): what was read on an
 * earlier page is gone from the last one. Bounded — the latest steps, and a
 * short excerpt of each page — so it never crowds the final page out.
 */

import { ControlSnapshot } from "../devtools/types";
import { linesSize, tailLines } from "./lines";
import { pathAndQuery } from "../util/url";

/** Steps kept (the latest). */
const MAX_STEPS: number = 30;
/** Pages kept (the most recently seen). */
const MAX_PAGES: number = 8;
/** Of each earlier page's text. */
const EXCERPT_CHARS: number = 500;

export interface JourneyStep {
    step: number;
    operation: string;
    /** The element acted on, as the engine saw it. */
    target?: string;
    /** What was typed (secrets by name only) or the key pressed. */
    text?: string;
    /** Refused / not executed: why. */
    refused?: string;
    /** The page the step led to. */
    url: string;
}

export interface VisitedPage {
    url: string;
    title: string;
    /** The start of the page's text as last seen there. */
    excerpt: string;
}

export interface Journey {
    steps: JourneyStep[];
    pages: VisitedPage[];
}

/** What a step event carries that the journey needs (agent and replay steps alike). */
export interface JourneyEvent {
    step: number;
    operation: string;
    target?: string;
    text?: string;
    key?: string;
    executed: boolean;
    reason?: string;
    userAction?: { prompt: string };
}

export class JourneyRecorder {
    private readonly steps: JourneyStep[] = [];
    /**
     * By URL, seen longest ago first: a re-seen page moves to the end with its latest text, and the
     * first goes when there are too many — so a page returned to (the cart read again) stays, and
     * the order handed on (`get`, a heal) and cut from (`describeJourney`) is the same recency.
     */
    private readonly pages: Map<string, VisitedPage> = new Map();
    private currentUrl: string = "";

    constructor(initial?: Journey) {
        // A journey handed over (a replay's, to the engine healing it) is already in recency order.
        for (const page of initial?.pages ?? []) {
            this.pages.set(page.url, page);
        }
        this.steps.push(...(initial?.steps ?? []));
        this.currentUrl = initial?.steps.at(-1)?.url ?? "";
    }

    /** A page as observed (every snapshot the run reads). A dialog over it is not a page. */
    see(page: Pick<ControlSnapshot, "url" | "title" | "text" | "dialog">): void {
        this.currentUrl = page.url;
        if (page.dialog) {
            return;
        }
        const visited: VisitedPage = {
            url: page.url,
            title: page.title,
            excerpt: page.text.replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS),
        };
        this.pages.delete(page.url);
        this.pages.set(page.url, visited);
        while (this.pages.size > MAX_PAGES) {
            this.pages.delete(this.pages.keys().next().value!);
        }
    }

    /** A step taken, after `see` of the page it led to. */
    step(event: JourneyEvent): void {
        const text: string | undefined = event.userAction ? `the user was asked: ${event.userAction.prompt}` : (event.key ?? event.text);
        this.steps.push({
            step: event.step,
            operation: event.operation,
            ...(event.target ? { target: event.target } : {}),
            ...(text !== undefined ? { text } : {}),
            ...(event.executed ? {} : { refused: event.reason ?? "not executed" }),
            url: this.currentUrl,
        });
        if (this.steps.length > MAX_STEPS) {
            this.steps.splice(0, this.steps.length - MAX_STEPS);
        }
    }

    get(): Journey {
        return { steps: [...this.steps], pages: [...this.pages.values()] };
    }
}


/**
 * The journey as the engine reads it: steps oldest first, then the pages (seen longest ago first)
 * with an excerpt each —
 * within `maxChars`: the earlier pages keep at least half of it when the steps need more, the steps
 * the rest (the latest of each kept).
 */
export function describeJourney(journey: Journey, finalUrl: string, maxChars: number = Infinity): string {
    const STEPS_HEADING: string = "Steps taken, oldest first:";
    const PAGES_HEADING: string = "Earlier pages (as last seen):";
    const stepLines: string[] = journey.steps.map((s: JourneyStep): string => {
        const what: string = [s.operation, s.target, s.text !== undefined ? JSON.stringify(s.text) : ""].filter(Boolean).join(" ");
        return `${s.step}. ${what}${s.refused ? ` — refused: ${s.refused}` : ` → ${pathAndQuery(s.url)}`}`;
    });
    const pageLines: string[] = journey.pages
        // The final page is shown in full elsewhere.
        .filter((p: VisitedPage): boolean => p.url !== finalUrl)
        .map((p: VisitedPage): string => `- ${p.title} ${pathAndQuery(p.url)}: ${p.excerpt}`);
    const room: number = maxChars - (stepLines.length ? STEPS_HEADING.length + 1 : 0) - (pageLines.length ? PAGES_HEADING.length + 3 : 0);
    const pages: string[] = tailLines(pageLines, Math.max(0, room - Math.min(linesSize(stepLines), room / 2)));
    const steps: string[] = tailLines(stepLines, Math.max(0, room - linesSize(pages)));
    return [steps.length ? `${STEPS_HEADING}\n${steps.join("\n")}` : "", pages.length ? `${PAGES_HEADING}\n${pages.join("\n")}` : ""]
        .filter(Boolean)
        .join("\n\n");
}
