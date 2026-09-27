import { buildTextChoices, QuotedLiteralSource, SuppliedValuesSource } from "./candidates";
import { LlmTextGenerator } from "./generators/llm";
import { providerAvailable, ProviderSettings, PROVIDER_REQUIREMENTS, TextModelRef, TextProvider } from "./providers";
import { CandidateKind, TextCandidateSource, TextGenerator, TextStrategy } from "./types";

export * from "./candidates";
export * from "./cli-providers";
export * from "./generators/llm";
export * from "./mask";
export * from "./providers";
export * from "./types";

export interface TextConfig {
    /** Which candidate sources feed the engine's value choice, in order. */
    candidates: CandidateKind[];
    /** The text model (an API or CLI provider) that writes a value when none fits; none = only the candidates are typed. */
    model?: TextModelRef;
    /** Keys and endpoints per provider (a provider without a key is unavailable). */
    providers: Record<TextProvider, ProviderSettings>;
}

export interface RunValues {
    values: Record<string, string>;
    secrets: Record<string, string>;
    /** What each value / secret is for, by name (optional). */
    descriptions?: Record<string, string>;
    /** Secrets seeded in DevTools: the `{{secret:…}}` reference typed in place of the value, by name. */
    secretRefs?: Record<string, string>;
}

export function createTextGenerator(config: TextConfig): TextGenerator | undefined {
    if (!config.model) {
        return undefined;
    }
    const settings: ProviderSettings = config.providers[config.model.provider];
    if (!providerAvailable(config.model.provider, settings)) {
        throw new Error(
            `The text model ${config.model.provider}/${config.model.model} is unavailable: ${PROVIDER_REQUIREMENTS[config.model.provider]}`
        );
    }
    return new LlmTextGenerator({ model: config.model, settings });
}

function createSource(kind: CandidateKind, run: RunValues): TextCandidateSource {
    switch (kind) {
        case CandidateKind.SUPPLIED:
            return new SuppliedValuesSource(run.values, run.secrets, run.descriptions, run.secretRefs);
        case CandidateKind.QUOTED:
            return new QuotedLiteralSource();
    }
}

/**
 * The text setup for one run. Supplied values are always offered, first.
 * `askUser`: a person is there to type what nothing else provides (the ASK_USER text choice is offered).
 */
export function createTextStrategy(goal: string, config: TextConfig, run: RunValues, askUser: boolean = false): TextStrategy {
    const kinds: CandidateKind[] = [
        CandidateKind.SUPPLIED,
        ...config.candidates.filter((k: CandidateKind): boolean => k !== CandidateKind.SUPPLIED),
    ];
    const generator: TextGenerator | undefined = createTextGenerator(config);
    return {
        choices: buildTextChoices(
            goal,
            kinds.map((k: CandidateKind): TextCandidateSource => createSource(k, run)),
            generator !== undefined,
            run.secrets,
            askUser
        ),
        generator,
        secrets: run.secrets,
        secretsInDevtools: Object.keys(run.secrets).every((name: string): boolean => run.secretRefs?.[name] !== undefined),
    };
}
