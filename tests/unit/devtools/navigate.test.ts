import { DevtoolsClient } from "../../../src/devtools/client";

/** A client whose DevTools calls answer from `statuses`, one per page load, and are recorded. */
class StubClient extends DevtoolsClient {
    readonly calls: string[] = [];
    readonly inputs: Array<Record<string, unknown>> = [];

    constructor(private readonly statuses: number[]) {
        super({ baseUrl: "http://stub", sessionId: "stub" });
    }

    override async call<T>(toolName: string, toolInput: object): Promise<T> {
        this.calls.push(toolName);
        this.inputs.push(toolInput as Record<string, unknown>);
        if (toolName === "navigation_go-to") {
            return { status: this.statuses.shift() } as T;
        }
        return { waitedMs: 0, finalInFlightRequests: 0 } as T;
    }
}

describe("DevtoolsClient.navigate", (): void => {
    it("loads a start page once more when its first visit is refused", async (): Promise<void> => {
        const client: StubClient = new StubClient([403, 200]);
        await client.navigate("https://shop.test/");
        expect(client.calls).toEqual(["navigation_go-to", "navigation_go-to"]);
    });

    it("leaves the settle after each load to DevTools", async (): Promise<void> => {
        const client: StubClient = new StubClient([403, 200]);
        await client.navigate("https://shop.test/");
        for (const input of client.inputs) {
            expect(input).not.toHaveProperty("waitForNavigation");
        }
    });

    it("reads the run's traffic from the load the page shows, not from a refused first visit", async (): Promise<void> => {
        const refused: StubClient = new StubClient([403, 200]);
        const before: number = Date.now();
        const from: number = await refused.navigate("https://shop.test/");
        expect(from).toBeGreaterThanOrEqual(before);
        expect(refused.calls).toEqual(["navigation_go-to", "navigation_go-to"]);
        const plain: StubClient = new StubClient([200]);
        const plainBefore: number = Date.now();
        expect(await plain.navigate("https://shop.test/")).toBeGreaterThanOrEqual(plainBefore);
    });

    it("loads it once more only once", async (): Promise<void> => {
        const client: StubClient = new StubClient([503, 503, 200]);
        await client.navigate("https://shop.test/");
        expect(client.calls.filter((c: string): boolean => c === "navigation_go-to")).toHaveLength(2);
    });

    it("loads a page that answers normally, or with another error, once", async (): Promise<void> => {
        for (const status of [200, 404, 500]) {
            const client: StubClient = new StubClient([status]);
            await client.navigate("https://shop.test/");
            expect(client.calls).toEqual(["navigation_go-to"]);
        }
    });
});
