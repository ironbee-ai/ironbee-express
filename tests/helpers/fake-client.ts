/** A DevTools client whose act() answers from a queue, with a settable page text. */

import { DevtoolsClient, NetworkWait, RecordingStopped } from "../../src/devtools/client";
import { ActRequest, ActResult, ControlSnapshot, SnapshotLimits } from "../../src/devtools/types";
import { CapturedRequest, ConsoleEntry } from "../../src/verify/types";

export class FakeClient extends DevtoolsClient {
    readonly acts: ActRequest[] = [];
    snapshots: number = 0;
    pageTextValue: string = "";
    recording: boolean = false;
    requests: CapturedRequest[] = [];
    consoleEntries: ConsoleEntry[] = [];
    evidenceReadsSince: number[] = [];

    constructor(
        private current: ControlSnapshot,
        private readonly results: Array<(request: ActRequest) => ActResult>
    ) {
        super({ baseUrl: "http://fake", sessionId: "fake" });
    }

    /** The page as it is now — e.g. after a person acted on it. */
    setPage(page: ControlSnapshot): void {
        this.current = page;
    }

    override async navigate(): Promise<number> {
        return Date.now();
    }

    override async snapshot(_limits: SnapshotLimits): Promise<ControlSnapshot> {
        this.snapshots++;
        return this.current;
    }

    override async pageText(): Promise<string> {
        return this.pageTextValue;
    }

    override async appRequests(sinceMs: number): Promise<CapturedRequest[]> {
        this.evidenceReadsSince.push(sinceMs);
        return this.requests;
    }

    override async settleNetwork(): Promise<void> {}

    override async waitForQuiet(): Promise<NetworkWait> {
        return NetworkWait.QUIET;
    }

    override async consoleErrors(): Promise<ConsoleEntry[]> {
        return this.consoleEntries;
    }

    override async startRecording(): Promise<void> {
        this.recording = true;
    }

    override async stopRecording(): Promise<RecordingStopped> {
        this.recording = false;
        return { filePath: "/tmp/fake.webm" };
    }

    override async act(request: ActRequest): Promise<ActResult> {
        this.acts.push(request);
        const next: ((request: ActRequest) => ActResult) | undefined = this.results.shift();
        if (!next) {
            throw new Error("unexpected act");
        }
        const result: ActResult = next(request);
        if (result.snapshot) {
            this.current = result.snapshot;
        }
        return result;
    }

    override async close(): Promise<void> {}
}
