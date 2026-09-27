import { createEngine } from "../../../src/engine";
import { JevEngine } from "../../../src/engine/jev";
import { DecisionEngine, EngineHealth, EngineKind } from "../../../src/engine/types";

describe("createEngine", (): void => {
    it("builds the configured engine behind the engine interface", (): void => {
        const jev: DecisionEngine = createEngine({ kind: EngineKind.JEV, jev: { apiKey: "k" } });
        expect(jev).toBeInstanceOf(JevEngine);
        expect(jev.kind).toBe(EngineKind.JEV);
        expect(jev.profile.compact).toBe(false);
    });
});

describe("JevEngine", (): void => {
    it("is unhealthy without a key", async (): Promise<void> => {
        const health: EngineHealth = await new JevEngine({ apiKey: "" }).health();
        expect(health.ok).toBe(false);
        expect(health.detail).toMatch(/TYPESAFE_API_KEY/);
    });
});
