import { DevtoolsClient, SECRET_DENIED } from "../../../src/devtools/client";
import { boundOriginOf, newFrameHosts, SeededSecrets, secretBundle } from "../../../src/devtools/secrets";
import { ActResult, ControlAction } from "../../../src/devtools/types";

describe("secretBundle", (): void => {
    it("seeds the secrets marked as passwords as login passwords, anything else as a generic value, whatever its name", (): void => {
        const seeded: SeededSecrets = secretBundle(
            { pin: "1234", password: "pw", "api-key": "k", "bad name": "x", empty: "" },
            { "api-key": "the partner API key" },
            ["pin"],
            "127.0.0.1:3000"
        );
        expect(seeded.bundle.secrets).toEqual([
            { name: "pin", type: "login-credentials", fields: { password: "1234" }, boundOrigins: ["127.0.0.1:3000"] },
            // Named like one, but not marked: its name decides nothing.
            { name: "password", type: "generic", fields: { value: "pw" }, boundOrigins: ["127.0.0.1:3000"] },
            {
                name: "api-key",
                description: "the partner API key",
                type: "generic",
                fields: { value: "k" },
                boundOrigins: ["127.0.0.1:3000"],
            },
        ]);
        // A name DevTools cannot hold is typed by value, as before.
        expect(seeded.refs).toEqual({
            pin: "{{secret:pin.password}}",
            password: "{{secret:password.value}}",
            "api-key": "{{secret:api-key.value}}",
        });
    });

    it("seeds a name as long as DevTools accepts, and skips a longer one", (): void => {
        const long: string = "n".repeat(255);
        const seeded: SeededSecrets = secretBundle({ [long]: "v", [`${long}x`]: "w" }, {}, [], "shop.test");
        expect(seeded.bundle.secrets.map((s: { name: string }): string => s.name)).toEqual([long]);
        expect(seeded.refs[long]).toBe(`{{secret:${long}.value}}`);
        expect(seeded.refs[`${long}x`]).toBeUndefined();
    });

    it("does not seed a value DevTools would refuse, so the other secrets still reach it", (): void => {
        const seeded: SeededSecrets = secretBundle(
            { ok: "pw", long: "x".repeat(4097), edge: "y".repeat(4096), pem: "line1\nline2", tab: "a\tb", blank: "   " },
            {},
            [],
            "shop.test"
        );
        expect(seeded.bundle.secrets.map((s: { name: string }): string => s.name)).toEqual(["ok", "edge"]);
        expect(Object.keys(seeded.refs)).toEqual(["ok", "edge"]);
    });

    it("binds to several hosts, and names the frame hosts a snapshot adds", (): void => {
        const seeded: SeededSecrets = secretBundle({ card: "4111", password: "pw" }, {}, ["password"], "shop.test", ["pay.test"]);
        expect(seeded.bundle.secrets[0].boundOrigins).toEqual(["shop.test", "pay.test"]);
        // A password never leaves the start site.
        expect(seeded.bundle.secrets[1].boundOrigins).toEqual(["shop.test"]);
        const page = {
            controls: [
                { id: 1, role: "button", name: "Pay", ops: [] },
                { id: 100001, role: "textbox", name: "Card", ops: [], frame: "pay.test" },
                { id: 200001, role: "textbox", name: "Code", ops: [], frame: "otp.test" },
                { id: 200002, role: "button", name: "Go", ops: [], frame: "otp.test" },
            ],
        } as never;
        expect(newFrameHosts(page, ["shop.test", "pay.test"])).toEqual(["otp.test"]);
    });

    it("binds to the start URL's host and port, and to nothing without one", (): void => {
        expect(boundOriginOf("https://shop.test:8443/login")).toBe("shop.test:8443");
        expect(boundOriginOf("https://shop.test/")).toBe("shop.test");
        expect(boundOriginOf(undefined)).toBeUndefined();
        expect(boundOriginOf("file:///x")).toBeUndefined();
    });
});

describe("DevtoolsClient secrets", (): void => {
    const realFetch: typeof fetch = global.fetch;
    afterEach((): void => {
        global.fetch = realFetch;
    });

    function answering(reply: (url: string, init: RequestInit) => Response): Array<{ url: string; init: RequestInit }> {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        global.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
            calls.push({ url, init });
            return reply(url, init);
        }) as typeof fetch;
        return calls;
    }

    it("replaces the daemon's secrets behind its token", async (): Promise<void> => {
        const calls: Array<{ url: string; init: RequestInit }> = answering((): Response => new Response("{}", { status: 200 }));
        const client: DevtoolsClient = new DevtoolsClient({ baseUrl: "http://d", internalToken: "t" });
        expect(client.canSeedSecrets).toBe(true);
        await client.seedSecrets({ secrets: [] });
        expect(calls.map((c): string => `${c.init.method} ${c.url}`)).toEqual([
            "DELETE http://d/internal/secrets",
            "POST http://d/internal/secrets",
        ]);
        expect((calls[1].init.headers as Record<string, string>).authorization).toBe("Bearer t");
        expect(new DevtoolsClient({ baseUrl: "http://d" }).canSeedSecrets).toBe(false);
    });

    it("turns a refused secret reference into a refused action", async (): Promise<void> => {
        const snapshot: object = { snapshotId: "s2", controls: [] };
        answering((_url: string, init: RequestInit): Response => {
            const toolName: string = JSON.parse(String(init.body)).toolName;
            return toolName === "control_act"
                ? new Response(
                      JSON.stringify({ toolError: { code: SECRET_DENIED, message: "secret 'pw.password' may only be typed into a password input" } }),
                      { status: 500 }
                  )
                : new Response(JSON.stringify({ toolOutput: snapshot }), { status: 200 });
        });
        const result: ActResult = await new DevtoolsClient({ baseUrl: "http://d" }).act({
            action: ControlAction.FILL,
            snapshotId: "s",
            controlId: "c",
        } as never);
        expect(result).toEqual({ executed: false, reason: "secret 'pw.password' may only be typed into a password input", snapshot });
    });

    it("reads the control tools' own misplacement refusals the same way (a reference for a dialog, or outside a fill)", async (): Promise<void> => {
        for (const message of [
            "a {{secret:…}} reference cannot be typed into a native dialog",
            "a {{secret:…}} reference may only be the value of a fill",
        ]) {
            answering((): Response => new Response(JSON.stringify({ toolError: { code: SECRET_DENIED, message } }), { status: 500 }));
            const result: ActResult = await new DevtoolsClient({ baseUrl: "http://d" }).act({
                action: ControlAction.FILL,
                snapshotId: "s",
                controlId: "c",
                value: "{{secret:api.value}}",
                observe: false,
            } as never);
            expect(result).toEqual({ executed: false, reason: message });
        }
    });
});
