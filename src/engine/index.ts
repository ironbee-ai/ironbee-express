import { JevEngine } from "./jev";
import { DecisionEngine, EngineKind } from "./types";

export * from "./jev";
export * from "./systemone";
export * from "./types";

export interface EngineConfig {
    kind: EngineKind;
    jev: { apiKey?: string; model?: string; url?: string };
}

/**
 * The configured engine. Jev without a key is created anyway; its health says
 * why it cannot run. A new engine is a DecisionEngine + a kind + a case here.
 */
export function createEngine(config: EngineConfig): DecisionEngine {
    switch (config.kind) {
        case EngineKind.JEV:
            return new JevEngine({
                apiKey: config.jev.apiKey ?? "",
                model: config.jev.model,
                url: config.jev.url,
            });
    }
}
