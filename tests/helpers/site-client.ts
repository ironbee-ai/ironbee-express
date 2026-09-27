/**
 * A tiny stateful "site" behind the DevTools client interface: pages of
 * controls, and clicks that move between pages. Enough for the replayer and
 * the runner to act, wait, diverge and verify without a browser.
 */

import { DevtoolsClient, NetworkWait, RecordingStopped } from "../../src/devtools/client";
import { ActRequest, ActResult, Control, ControlAction, ControlSnapshot, SnapshotLimits } from "../../src/devtools/types";
import { CapturedRequest, ConsoleEntry } from "../../src/verify/types";
import { snapshot } from "./fixtures";

export interface SitePage {
    controls: Control[];
    text?: string;
    /** Control name → page it leads to when clicked. */
    links?: Record<string, string>;
}

export class SiteClient extends DevtoolsClient {
    readonly acts: ActRequest[] = [];
    readonly typed: Record<string, string> = {};
    page: string;
    requests: CapturedRequest[] = [];
    private seq: number = 0;

    constructor(
        readonly pages: Record<string, SitePage>,
        private readonly start: string
    ) {
        super({ baseUrl: "http://site", sessionId: "site" });
        this.page = start;
    }

    current(): ControlSnapshot {
        const page: SitePage = this.pages[this.page];
        const filled: string = Object.entries(this.typed)
            .map(([k, v]: [string, string]): string => `${k}=${v}`)
            .join(",");
        return snapshot(++this.seq, page.controls, {
            url: `https://site.test/${this.page}`,
            title: this.page,
            text: page.text ?? this.page,
            fingerprint: `${this.page}|${filled}`,
        });
    }

    override async navigate(): Promise<number> {
        this.page = this.start;
        return Date.now();
    }

    override async snapshot(_limits: SnapshotLimits): Promise<ControlSnapshot> {
        const page: ControlSnapshot = this.current();
        await this.onSnapshot?.(page);
        return page;
    }

    override async act(request: ActRequest): Promise<ActResult> {
        this.acts.push(request);
        if (request.action !== ControlAction.WAIT && request.controlId !== undefined) {
            const control: Control | undefined = this.pages[this.page].controls.find(
                (c: Control): boolean => c.id === request.controlId
            );
            if (!control) {
                return { executed: false, reason: "the element is gone", snapshot: this.current() };
            }
            if (request.action === ControlAction.FILL) {
                this.typed[control.name] = request.value ?? "";
            } else if (request.action === ControlAction.CLICK) {
                this.page = this.pages[this.page].links?.[control.name] ?? this.page;
            }
        }
        const next: ControlSnapshot = this.current();
        await this.onSnapshot?.(next);
        return { executed: true, snapshot: next };
    }

    override async pageText(): Promise<string> {
        return this.pages[this.page].text ?? this.page;
    }

    override async appRequests(): Promise<CapturedRequest[]> {
        return this.requests;
    }

    override async consoleErrors(): Promise<ConsoleEntry[]> {
        return [];
    }

    override async settleNetwork(): Promise<void> {}

    override async waitForQuiet(): Promise<NetworkWait> {
        return NetworkWait.QUIET;
    }

    override async startRecording(): Promise<void> {}

    override async stopRecording(): Promise<RecordingStopped> {
        return {};
    }

    override async close(): Promise<void> {}
}
