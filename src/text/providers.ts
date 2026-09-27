/**
 * The text models a run may use to WRITE a field value when none of the
 * offered values fits: the Anthropic, OpenAI or OpenRouter API (available
 * when its key is set) or the Claude Code / Codex CLI (available when
 * installed; they use their own login — cli-providers.ts). Each provider
 * lists its models (text in, text out only) and completes one prompt.
 *
 * A model is named `provider/model`: `anthropic/claude-haiku-4-5`,
 * `openai/gpt-4o-mini`, `claude-code/haiku`, `codex/default`,
 * `openrouter/inception/mercury-2.5` (OpenRouter's own
 * ids hold a slash; the provider is the part before the first one).
 */

import { pooledFetch } from "../net/http";
import { CLAUDE_CODE_MODELS, codexModels, completeWithClaudeCode, completeWithCodex } from "./cli-providers";

export enum TextProvider {
    ANTHROPIC = "anthropic",
    OPENAI = "openai",
    OPENROUTER = "openrouter",
    CLAUDE_CODE = "claude-code",
    CODEX = "codex",
}

/** Providers reached through a local CLI rather than an HTTP API. */
export const CLI_PROVIDERS: Set<TextProvider> = new Set([TextProvider.CLAUDE_CODE, TextProvider.CODEX]);

export interface ProviderSettings {
    /** API providers: the key (none = unavailable). */
    apiKey?: string;
    /** API providers: the endpoint. */
    baseUrl: string;
    /** CLI providers: the executable (none = not installed). */
    command?: string;
}

export function providerAvailable(provider: TextProvider, settings: ProviderSettings): boolean {
    return CLI_PROVIDERS.has(provider) ? Boolean(settings.command) : Boolean(settings.apiKey);
}

export interface TextModelInfo {
    /** The provider's model id (without the provider prefix). */
    id: string;
    /** Human-readable, when the provider gives one. */
    name?: string;
    /** Picked when the provider is chosen and no model is. */
    default?: boolean;
}

export interface TextModelRef {
    provider: TextProvider;
    model: string;
}

export const PROVIDER_LABELS: Record<TextProvider, string> = {
    [TextProvider.ANTHROPIC]: "Anthropic",
    [TextProvider.OPENAI]: "OpenAI",
    [TextProvider.OPENROUTER]: "OpenRouter",
    [TextProvider.CLAUDE_CODE]: "Claude Code CLI",
    [TextProvider.CODEX]: "Codex CLI",
};

/** What makes each provider available: its key variable, or its CLI. */
export const PROVIDER_REQUIREMENTS: Record<TextProvider, string> = {
    [TextProvider.ANTHROPIC]: "set ANTHROPIC_API_KEY",
    [TextProvider.OPENAI]: "set OPENAI_API_KEY",
    [TextProvider.OPENROUTER]: "set OPENROUTER_API_KEY",
    [TextProvider.CLAUDE_CODE]: "install the claude CLI",
    [TextProvider.CODEX]: "install the codex CLI",
};

export const DEFAULT_BASE_URLS: Record<TextProvider, string> = {
    [TextProvider.ANTHROPIC]: "https://api.anthropic.com/v1",
    [TextProvider.OPENAI]: "https://api.openai.com/v1",
    [TextProvider.OPENROUTER]: "https://openrouter.ai/api/v1",
    [TextProvider.CLAUDE_CODE]: "",
    [TextProvider.CODEX]: "",
};

const ANTHROPIC_VERSION: string = "2023-06-01";
const LIST_TIMEOUT_MS: number = 15_000;
const COMPLETE_TIMEOUT_MS: number = 30_000;
/**
 * Room for the longest text a model may write (`MAX_GENERATED_LENGTH`, 2 000 chars) inside its JSON
 * reply, in any script — and for a reasoning model's own reasoning tokens, which count against it.
 */
const MAX_OUTPUT_TOKENS: number = 4_096;

/** OpenAI's model list carries no modalities: these ids are not chat text models. */
const OPENAI_NOT_TEXT: RegExp = /embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|moderation|search|instruct|codex|computer-use|sora/i;
const OPENAI_TEXT: RegExp = /^(gpt-|o\d|chatgpt-)/i;

/** `openrouter/inception/mercury-2.5` → { openrouter, inception/mercury-2.5 }; undefined for "" / "none". */
export function parseTextModel(value: string | undefined): TextModelRef | undefined {
    const text: string = (value ?? "").trim();
    if (!text || text === "none") {
        return undefined;
    }
    const slash: number = text.indexOf("/");
    const provider: string = slash > 0 ? text.slice(0, slash) : "";
    const model: string = text.slice(slash + 1);
    if (!(Object.values(TextProvider) as string[]).includes(provider) || !model) {
        throw new Error(`A text model reads provider/model with provider ${Object.values(TextProvider).join(" | ")}, got ${JSON.stringify(text)}`);
    }
    return { provider: provider as TextProvider, model };
}

export function formatTextModel(ref: TextModelRef): string {
    return `${ref.provider}/${ref.model}`;
}

function base(settings: ProviderSettings): string {
    return settings.baseUrl.replace(/\/$/, "");
}

function headers(provider: TextProvider, apiKey: string): Record<string, string> {
    return provider === TextProvider.ANTHROPIC
        ? { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" }
        : { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
}

async function getJson(url: string, init: RequestInit, fetchImpl: typeof fetch, what: string): Promise<any> {
    const response: Response = await fetchImpl(url, init);
    if (!response.ok) {
        throw new Error(`${what}: HTTP ${response.status}`);
    }
    return response.json();
}

/** The provider's text models (text in, text out), sorted for a picker. */
export async function listTextModels(
    provider: TextProvider,
    settings: ProviderSettings,
    fetchImpl: typeof fetch = pooledFetch
): Promise<TextModelInfo[]> {
    if (!providerAvailable(provider, settings)) {
        throw new Error(`${PROVIDER_LABELS[provider]}: ${PROVIDER_REQUIREMENTS[provider]}`);
    }
    // The CLIs have no model-list call: Claude Code's aliases, Codex's cached list.
    if (provider === TextProvider.CLAUDE_CODE) {
        return CLAUDE_CODE_MODELS.map((m: { id: string; name: string; default?: boolean }): TextModelInfo => ({ ...m }));
    }
    if (provider === TextProvider.CODEX) {
        return codexModels();
    }
    const init: RequestInit = { headers: headers(provider, settings.apiKey!), signal: AbortSignal.timeout(LIST_TIMEOUT_MS) };
    const what: string = `${PROVIDER_LABELS[provider]} model list`;
    switch (provider as TextProvider.ANTHROPIC | TextProvider.OPENAI | TextProvider.OPENROUTER) {
        case TextProvider.ANTHROPIC: {
            const body: { data?: Array<{ id: string; display_name?: string }> } = await getJson(
                `${base(settings)}/models?limit=1000`,
                init,
                fetchImpl,
                what
            );
            return (body.data ?? []).map((m: { id: string; display_name?: string }): TextModelInfo => ({
                id: m.id,
                ...(m.display_name ? { name: m.display_name } : {}),
            }));
        }
        case TextProvider.OPENAI: {
            const body: { data?: Array<{ id: string; created?: number }> } = await getJson(`${base(settings)}/models`, init, fetchImpl, what);
            return (body.data ?? [])
                .filter((m: { id: string }): boolean => OPENAI_TEXT.test(m.id) && !OPENAI_NOT_TEXT.test(m.id))
                .sort((a: { created?: number }, b: { created?: number }): number => (b.created ?? 0) - (a.created ?? 0))
                .map((m: { id: string }): TextModelInfo => ({ id: m.id }));
        }
        case TextProvider.OPENROUTER: {
            const body: {
                data?: Array<{ id: string; name?: string; architecture?: { input_modalities?: string[]; output_modalities?: string[] } }>;
            } = await getJson(`${base(settings)}/models`, init, fetchImpl, what);
            return (body.data ?? [])
                .filter(
                    (m: { architecture?: { input_modalities?: string[]; output_modalities?: string[] } }): boolean =>
                        (m.architecture?.input_modalities ?? ["text"]).includes("text") &&
                        (m.architecture?.output_modalities ?? ["text"]).includes("text")
                )
                .map((m: { id: string; name?: string }): TextModelInfo => ({ id: m.id, ...(m.name ? { name: m.name } : {}) }))
                .sort((a: TextModelInfo, b: TextModelInfo): number => (a.name ?? a.id).localeCompare(b.name ?? b.id));
        }
    }
}

/** An image sent with a prompt (a screenshot): base64 data and its type. */
export interface TextImage {
    mimeType: string;
    data: string;
}

/** One completion: a system prompt and a user message (and images) in, the model's text out. */
export async function completeText(
    ref: TextModelRef,
    settings: ProviderSettings,
    system: string,
    user: string,
    fetchImpl: typeof fetch = pooledFetch,
    images: TextImage[] = []
): Promise<string> {
    if (!providerAvailable(ref.provider, settings)) {
        throw new Error(`${PROVIDER_LABELS[ref.provider]}: ${PROVIDER_REQUIREMENTS[ref.provider]}`);
    }
    if (ref.provider === TextProvider.CLAUDE_CODE) {
        return completeWithClaudeCode(settings.command!, ref.model, system, user, images);
    }
    if (ref.provider === TextProvider.CODEX) {
        return completeWithCodex(settings.command!, ref.model, system, user, images);
    }
    const what: string = `${formatTextModel(ref)}`;
    const init: (body: unknown) => RequestInit = (body: unknown): RequestInit => ({
        method: "POST",
        headers: headers(ref.provider, settings.apiKey!),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
    });
    if (ref.provider === TextProvider.ANTHROPIC) {
        const body: { content?: Array<{ type: string; text?: string }>; stop_reason?: string } = await getJson(
            `${base(settings)}/messages`,
            init({
                model: ref.model,
                max_tokens: MAX_OUTPUT_TOKENS,
                system,
                messages: [
                    {
                        role: "user",
                        content: images.length
                            ? [
                                ...images.map((i: TextImage): Record<string, unknown> => ({
                                    type: "image",
                                    source: { type: "base64", media_type: i.mimeType, data: i.data },
                                })),
                                { type: "text", text: user },
                            ]
                            : user,
                    },
                ],
            }),
            fetchImpl,
            what
        );
        if (body.stop_reason === "max_tokens") {
            throw new Error(`${what}: the reply was cut at ${MAX_OUTPUT_TOKENS} output tokens`);
        }
        return (body.content ?? [])
            .filter((c: { type: string }): boolean => c.type === "text")
            .map((c: { text?: string }): string => c.text ?? "")
            .join("");
    }
    // OpenAI and OpenRouter speak Chat Completions. OpenAI's newer models take max_completion_tokens.
    const limit: Record<string, number> =
        ref.provider === TextProvider.OPENAI ? { max_completion_tokens: MAX_OUTPUT_TOKENS } : { max_tokens: MAX_OUTPUT_TOKENS };
    const body: { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> } = await getJson(
        `${base(settings)}/chat/completions`,
        init({
            model: ref.model,
            ...limit,
            messages: [
                { role: "system", content: system },
                {
                    role: "user",
                    content: images.length
                        ? [
                            ...images.map((i: TextImage): Record<string, unknown> => ({
                                type: "image_url",
                                image_url: { url: `data:${i.mimeType};base64,${i.data}` },
                            })),
                            { type: "text", text: user },
                        ]
                        : user,
                },
            ],
        }),
        fetchImpl,
        what
    );
    // A cut reply is half a JSON object: say so, rather than let it read as a malformed answer.
    if (body.choices?.[0]?.finish_reason === "length") {
        throw new Error(`${what}: the reply was cut at ${MAX_OUTPUT_TOKENS} output tokens`);
    }
    return body.choices?.[0]?.message?.content ?? "";
}
