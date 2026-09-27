import { DEFAULT_DAEMON_PORT, FastConfig, loadConfig } from "../../../src/config/config";
import { EngineKind } from "../../../src/engine/types";
import { TextProvider } from "../../../src/text/providers";
import { CandidateKind } from "../../../src/text/types";

describe("loadConfig", (): void => {
    it("defaults to Jev, supplied + quoted candidates, no text model", (): void => {
        const config: FastConfig = loadConfig({});
        expect(config.engine.kind).toBe(EngineKind.JEV);
        expect(config.text.candidates).toEqual([CandidateKind.SUPPLIED, CandidateKind.QUOTED]);
        expect(config.text.model).toBeUndefined();
        expect(config.text.providers[TextProvider.ANTHROPIC].apiKey).toBeUndefined();
        expect(config.daemon.port).toBe(DEFAULT_DAEMON_PORT);
        expect(config.daemon.headless).toBe(true);
    });

    it("selects the engine and text setup from the environment", (): void => {
        const config: FastConfig = loadConfig({
            IBEXPRESS_ENGINE: "jev",
            TYPESAFE_MODEL: "jev-latest",
            IBEXPRESS_TEXT_CANDIDATES: "supplied",
            IBEXPRESS_TEXT_MODEL: "openrouter/inception/mercury-2.5",
            OPENROUTER_API_KEY: "or-k",
            JEV_API_KEY: "k",
            IBEXPRESS_HEADLESS: "false",
        });
        expect(config.engine.kind).toBe(EngineKind.JEV);
        expect(config.engine.jev.model).toBe("jev-latest");
        expect(config.engine.jev.apiKey).toBe("k");
        expect(config.text.candidates).toEqual([CandidateKind.SUPPLIED]);
        expect(config.text.model).toEqual({ provider: TextProvider.OPENROUTER, model: "inception/mercury-2.5" });
        expect(config.text.providers[TextProvider.OPENROUTER]).toEqual({ apiKey: "or-k", baseUrl: "https://openrouter.ai/api/v1" });
        expect(config.daemon.headless).toBe(false);
    });

    it("rejects unknown values instead of silently falling back", (): void => {
        expect((): FastConfig => loadConfig({ IBEXPRESS_ENGINE: "gpt" })).toThrow(/IBEXPRESS_ENGINE=gpt/);
        expect((): FastConfig => loadConfig({ IBEXPRESS_TEXT_CANDIDATES: "spans" })).toThrow(/IBEXPRESS_TEXT_CANDIDATES/);
        expect((): FastConfig => loadConfig({ IBEXPRESS_TEXT_MODEL: "mistral/large" })).toThrow(/provider\/model/);
        expect((): FastConfig => loadConfig({ IBEXPRESS_UI_PORT: "-1" })).toThrow(/IBEXPRESS_UI_PORT/);
    });
});
