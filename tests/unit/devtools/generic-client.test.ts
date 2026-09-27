import { GenericDevtoolsClient } from "../../../src/devtools/generic-client";
import { ControlAction } from "../../../src/devtools/types";

/** Records the tool calls instead of reaching a daemon. */
class RecordingClient extends GenericDevtoolsClient {
    readonly calls: { toolName: string; toolInput: object }[] = [];

    override async call<T>(toolName: string, toolInput: object): Promise<T> {
        this.calls.push({ toolName, toolInput });
        return {} as T;
    }
}

describe("GenericDevtoolsClient snapshot", (): void => {
    it("does not probe the scroll position with an action DevTools refuses", async (): Promise<void> => {
        const client: RecordingClient = new RecordingClient({ baseUrl: "http://127.0.0.1:1" });
        await client.snapshot({ maxControls: 10, maxTextChars: 100 }).catch((): undefined => undefined);
        const scrolled: { toolName: string; toolInput: object } | undefined = client.calls.find(
            (c: { toolName: string; toolInput: object }): boolean => c.toolName === "interaction_scroll"
        );
        expect(scrolled).toBeUndefined();
    });
});

describe("GenericDevtoolsClient twins", (): void => {
    const FULL: string = [
        "- Page URL: http://x/",
        "- Page Title: Shop",
        "```yaml",
        "- list:",
        "  - listitem:",
        '    - heading "Apple" [level=2] [ref=e1]',
        '    - button "Add to cart" [ref=e2]',
        "  - listitem:",
        '    - heading "Banana (out of stock)" [level=2] [ref=e3]',
        '    - button "Add to cart" [disabled] [ref=e4]',
        "  - listitem:",
        '    - heading "Cherry" [level=2] [ref=e5]',
        '    - button "Add to cart" [ref=e6]',
        "```",
        "",
    ].join("\n");

    /** Answers the snapshot's calls with the page above; `listsDisabled`: the interactive tree names the disabled twin too. */
    class ShopClient extends GenericDevtoolsClient {
        constructor(private readonly listsDisabled: boolean) {
            super({ baseUrl: "http://127.0.0.1:1" });
        }

        override async call<T>(toolName: string, toolInput: object): Promise<T> {
            if (toolName === "a11y_take-aria-snapshot") {
                const interactive: string = [
                    "- Page URL: http://x/",
                    "- Page Title: Shop",
                    "```yaml",
                    '- button "Add to cart" [ref=e2]',
                    ...(this.listsDisabled ? ['- button "Add to cart" [disabled] [ref=e4]'] : []),
                    '- button "Add to cart" [ref=e6]',
                    "```",
                    "",
                ].join("\n");
                return { output: (toolInput as { interactiveOnly?: boolean }).interactiveOnly ? interactive : FULL, refs: {} } as T;
            }
            if (toolName === "content_get-as-text") {
                return { output: "" } as T;
            }
            return { tabs: [] } as T;
        }
    }

    it("labels each offered twin with its own context when a disabled twin sits between them", async (): Promise<void> => {
        for (const listsDisabled of [false, true]) {
            const page = await new ShopClient(listsDisabled).snapshot({ maxControls: 50, maxTextChars: 100 });
            const buttons = page.controls.filter((c) => c.name === "Add to cart");
            expect(buttons.map((c) => [c.id, c.context])).toEqual([
                [2, expect.stringContaining("Apple")],
                [6, expect.stringContaining("Cherry")],
            ]);
        }
    });
});

describe("GenericDevtoolsClient tab actions", (): void => {
    it("closes the active tab when no index is given, instead of sending index: NaN", async (): Promise<void> => {
        const client: RecordingClient = new RecordingClient({ baseUrl: "http://127.0.0.1:1" });
        await client.act({ action: ControlAction.CLOSE_TAB, observe: false });
        const closed: { toolName: string; toolInput: object } | undefined = client.calls.find(
            (c: { toolName: string; toolInput: object }): boolean => c.toolName === "navigation_close-tab"
        );
        expect(closed?.toolInput).toEqual({});
    });

    it("closes the tab named by the value", async (): Promise<void> => {
        const client: RecordingClient = new RecordingClient({ baseUrl: "http://127.0.0.1:1" });
        await client.act({ action: ControlAction.CLOSE_TAB, value: "2", observe: false });
        const closed: { toolName: string; toolInput: object } | undefined = client.calls.find(
            (c: { toolName: string; toolInput: object }): boolean => c.toolName === "navigation_close-tab"
        );
        expect(closed?.toolInput).toEqual({ index: 2 });
    });
});
