import { RunSpec } from "../../../src/run/runner";
import { parseRunRequest, saveScenarioDefinition, ScenarioExistsError } from "../../../src/server/ui-server";
import { ScenarioStore } from "../../../src/scenario/store";
import { Scenario } from "../../../src/scenario/types";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CandidateKind } from "../../../src/text/types";

describe("parseRunRequest", (): void => {
    it("splits values and secrets, ignores what the user no longer configures, and records the run", (): void => {
        // Fields the user no longer configures (checks, engine) are ignored.
        const body: Record<string, unknown> = {
            goal: "  Log in  ",
            url: "https://eshop.demo.ironbee.dev",
            values: [
                { name: "email", value: "a@b.c", secret: false },
                { name: "password", value: "pw", secret: true },
                { name: "", value: "ignored" },
            ],
            checks: [{ kind: "claim", value: "An order is listed" }],
            engine: "laya",
            textModel: "anthropic/claude-haiku-4-5",
            textCandidates: ["quoted", "spans"],
        };
        const spec: RunSpec = parseRunRequest(body as Parameters<typeof parseRunRequest>[0]);
        expect(spec.goal).toBe("Log in");
        expect(spec.url).toBe("https://eshop.demo.ironbee.dev/");
        expect(spec.values).toEqual({ email: "a@b.c" });
        expect(spec.secrets).toEqual({ password: "pw" });
        expect(spec).not.toHaveProperty("checks");
        expect(spec).not.toHaveProperty("engine");
        expect(spec.textModel).toBe("anthropic/claude-haiku-4-5");
        expect(spec.textCandidates).toEqual([CandidateKind.QUOTED]);
        expect(spec.record).toBe(true);
    });

    it("keeps each value's description by name", (): void => {
        const spec: RunSpec = parseRunRequest({
            goal: "x",
            values: [
                { name: "address", value: "Main St.", description: " the delivery address " },
                { name: "card", value: "4111", secret: true, description: "the card number" },
                { name: "email", value: "a@b.c", description: "  " },
            ],
        } as Parameters<typeof parseRunRequest>[0]);
        expect(spec.valueDescriptions).toEqual({ address: "the delivery address", card: "the card number" });
    });

    it("rejects a missing goal and a non-http URL", (): void => {
        expect((): RunSpec => parseRunRequest({ goal: " " })).toThrow(/goal/);
        expect((): RunSpec => parseRunRequest({ goal: "x", url: "file:///etc/passwd" })).toThrow(/http/);
    });

    it("takes none as no text model, and refuses a malformed one", (): void => {
        expect(parseRunRequest({ goal: "x", textModel: "none" }).textModel).toBe("none");
        expect((): RunSpec => parseRunRequest({ goal: "x", textModel: "big" })).toThrow(/provider\/model/);
    });
});

describe("saveScenarioDefinition", (): void => {
    it("saves the form without secret values, and never a recording", (): void => {
        const dir: string = mkdtempSync(join(tmpdir(), "ibexpress-save-"));
        try {
            const store: ScenarioStore = new ScenarioStore(dir);
            const body = {
                goal: "Log in",
                url: "https://shop.test/",
                values: [
                    { name: "email", value: "a@b.c" },
                    { name: "password", value: "pw", secret: true },
                ],
                };
            const first: Scenario = saveScenarioDefinition(store, "login", body);
            expect(first.secretNames).toEqual(["password"]);
            expect(JSON.stringify(store.get("login"))).not.toContain('"pw"');
            // An existing scenario is replaced only when asked to.
            expect((): Scenario => saveScenarioDefinition(store, "login", { ...body, values: [{ name: "email", value: "x@y.z" }] })).toThrow(
                ScenarioExistsError
            );
            const second: Scenario = saveScenarioDefinition(store, "login", {
                ...body,
                values: [{ name: "email", value: "x@y.z" }],
                overwrite: true,
            });
            expect(second).not.toHaveProperty("recording");
            expect(second.values).toEqual({ email: "x@y.z" });
            expect(second.createdAt).toBe(first.createdAt);
            expect((): Scenario => saveScenarioDefinition(store, "bad name!", body)).toThrow();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
