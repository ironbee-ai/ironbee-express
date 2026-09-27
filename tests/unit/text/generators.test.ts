import { LlmTextGenerator, parseTextReply } from "../../../src/text/generators/llm";
import { childEnv, findOnPath, readRulesFor } from "../../../src/text/cli-providers";
import {
    completeText,
    formatTextModel,
    listTextModels,
    parseTextModel,
    providerAvailable,
    TextModelInfo,
    TextProvider,
} from "../../../src/text/providers";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FieldContext } from "../../../src/text/types";

const CONTEXT: FieldContext = {
    goal: "Ship to Main St. No:1, Springfield",
    field: { name: "Full delivery address", role: "textbox" },
    page: { title: "Checkout", text: "Shipping Address" },
    recentActions: [],
};

interface Call {
    url: string;
    headers: Record<string, string>;
    body?: any;
}

/** A fetch that records calls and answers with `reply(url)`. */
function recording(reply: (url: string) => unknown, status: number = 200): { fetchImpl: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl: typeof fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
        calls.push({
            url,
            headers: (init?.headers ?? {}) as Record<string, string>,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        return new Response(JSON.stringify(reply(url)), { status });
    }) as typeof fetch;
    return { fetchImpl, calls };
}

describe("parseTextModel", (): void => {
    it("reads provider/model, keeping the slashes of an OpenRouter id, and none", (): void => {
        expect(parseTextModel("openrouter/inception/mercury-2.5")).toEqual({ provider: TextProvider.OPENROUTER, model: "inception/mercury-2.5" });
        expect(parseTextModel("anthropic/claude-haiku-4-5")).toEqual({ provider: TextProvider.ANTHROPIC, model: "claude-haiku-4-5" });
        expect(parseTextModel("none")).toBeUndefined();
        expect(parseTextModel(undefined)).toBeUndefined();
        expect((): unknown => parseTextModel("mistral/large")).toThrow(/provider\/model/);
        expect(formatTextModel({ provider: TextProvider.OPENAI, model: "gpt-4o-mini" })).toBe("openai/gpt-4o-mini");
    });
});

describe("listTextModels", (): void => {
    it("lists Anthropic's models with its own headers", async (): Promise<void> => {
        const { fetchImpl, calls } = recording(() => ({ data: [{ id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" }] }));
        const models: TextModelInfo[] = await listTextModels(TextProvider.ANTHROPIC, { apiKey: "k", baseUrl: "https://a.test/v1" }, fetchImpl);
        expect(models).toEqual([{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }]);
        expect(calls[0].url).toBe("https://a.test/v1/models?limit=1000");
        expect(calls[0].headers).toMatchObject({ "x-api-key": "k", "anthropic-version": "2023-06-01" });
    });

    it("keeps only OpenAI's chat text models, newest first", async (): Promise<void> => {
        const { fetchImpl } = recording(() => ({
            data: [
                { id: "gpt-4o-mini", created: 2 },
                { id: "text-embedding-3-small", created: 3 },
                { id: "whisper-1", created: 4 },
                { id: "gpt-4o-mini-tts", created: 5 },
                { id: "o3-mini", created: 6 },
                { id: "dall-e-3", created: 7 },
            ],
        }));
        const models: TextModelInfo[] = await listTextModels(TextProvider.OPENAI, { apiKey: "k", baseUrl: "https://o.test/v1" }, fetchImpl);
        expect(models.map((m: TextModelInfo): string => m.id)).toEqual(["o3-mini", "gpt-4o-mini"]);
    });

    it("keeps only OpenRouter's text-in, text-out models", async (): Promise<void> => {
        const { fetchImpl } = recording(() => ({
            data: [
                { id: "inception/mercury-2.5", name: "Mercury 2.5", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
                { id: "google/image-gen", name: "Image Gen", architecture: { input_modalities: ["text"], output_modalities: ["image"] } },
                { id: "anthropic/claude-3.5", name: "Claude", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
            ],
        }));
        const models: TextModelInfo[] = await listTextModels(TextProvider.OPENROUTER, { apiKey: "k", baseUrl: "https://r.test/api/v1" }, fetchImpl);
        expect(models.map((m: TextModelInfo): string => m.id)).toEqual(["anthropic/claude-3.5", "inception/mercury-2.5"]);
    });

    it("needs the provider's key", async (): Promise<void> => {
        await expect(listTextModels(TextProvider.OPENAI, { baseUrl: "x" })).rejects.toThrow(/OPENAI_API_KEY/);
    });
});

describe("completeText", (): void => {
    it("speaks the Anthropic Messages API", async (): Promise<void> => {
        const { fetchImpl, calls } = recording(() => ({ content: [{ type: "text", text: '{"text": "x"}' }] }));
        const reply: string = await completeText(
            { provider: TextProvider.ANTHROPIC, model: "claude-haiku-4-5" },
            { apiKey: "k", baseUrl: "https://a.test/v1" },
            "sys",
            "user",
            fetchImpl
        );
        expect(reply).toBe('{"text": "x"}');
        expect(calls[0].url).toBe("https://a.test/v1/messages");
        expect(calls[0].body).toMatchObject({ model: "claude-haiku-4-5", system: "sys", messages: [{ role: "user", content: "user" }] });
    });

    it("speaks Chat Completions to OpenAI (max_completion_tokens) and OpenRouter (max_tokens)", async (): Promise<void> => {
        const { fetchImpl, calls } = recording(() => ({ choices: [{ message: { content: "ok" } }] }));
        await completeText({ provider: TextProvider.OPENAI, model: "gpt-4o-mini" }, { apiKey: "k", baseUrl: "https://o.test/v1" }, "s", "u", fetchImpl);
        await completeText({ provider: TextProvider.OPENROUTER, model: "inception/mercury-2.5" }, { apiKey: "k", baseUrl: "https://r.test/api/v1" }, "s", "u", fetchImpl);
        expect(calls[0].url).toBe("https://o.test/v1/chat/completions");
        expect(calls[0].body.max_completion_tokens).toBe(4096);
        expect(calls[0].headers.authorization).toBe("Bearer k");
        expect(calls[1].url).toBe("https://r.test/api/v1/chat/completions");
        expect(calls[1].body).toMatchObject({ model: "inception/mercury-2.5", max_tokens: 4096 });
    });

    it("says a reply was cut at the output limit, rather than handing back half a JSON object", async (): Promise<void> => {
        const anthropic = recording(() => ({ content: [{ type: "text", text: '{"text": "abc' }], stop_reason: "max_tokens" }));
        await expect(
            completeText({ provider: TextProvider.ANTHROPIC, model: "claude-haiku-4-5" }, { apiKey: "k", baseUrl: "https://a.test/v1" }, "s", "u", anthropic.fetchImpl)
        ).rejects.toThrow(/cut at 4096 output tokens/);
        const openai = recording(() => ({ choices: [{ message: { content: '{"text": "abc' }, finish_reason: "length" }] }));
        await expect(
            completeText({ provider: TextProvider.OPENAI, model: "gpt-4o-mini" }, { apiKey: "k", baseUrl: "https://o.test/v1" }, "s", "u", openai.fetchImpl)
        ).rejects.toThrow(/cut at 4096 output tokens/);
    });

    it("reports an HTTP error", async (): Promise<void> => {
        const { fetchImpl } = recording(() => ({}), 401);
        await expect(
            completeText({ provider: TextProvider.OPENAI, model: "m" }, { apiKey: "k", baseUrl: "https://o.test/v1" }, "s", "u", fetchImpl)
        ).rejects.toThrow(/HTTP 401/);
    });
});

describe("parseTextReply / LlmTextGenerator", (): void => {
    it("reads the text from a bare, fenced or wrapped JSON reply; null when the goal does not determine it", (): void => {
        expect(parseTextReply('{"text": "Main St. No:1"}')).toBe("Main St. No:1");
        expect(parseTextReply('```json\n{"text": "Main St. No:1"}\n```')).toBe("Main St. No:1");
        expect(parseTextReply('{"text": null}')).toBeNull();
        expect((): unknown => parseTextReply("Sure! The address is Main St.")).toThrow(/nothing typed/);
        expect((): unknown => parseTextReply('{"text": ""}')).toThrow(/nothing typed/);
        // A secret reference is never the model's own text (page text may bait it into writing one).
        expect((): unknown => parseTextReply('{"text": "{{secret:card.value}}"}')).toThrow(/nothing typed/);
        expect((): unknown => parseTextReply('{"text": "pay with {{ SECRET:card.value }}"}')).toThrow(/nothing typed/);
    });

    it("writes one field value with the chosen model", async (): Promise<void> => {
        const { fetchImpl, calls } = recording(() => ({ content: [{ type: "text", text: '{"text": "Main St. No:1, Springfield"}' }] }));
        const generator: LlmTextGenerator = new LlmTextGenerator({
            model: { provider: TextProvider.ANTHROPIC, model: "claude-haiku-4-5" },
            settings: { apiKey: "k", baseUrl: "https://a.test/v1" },
            fetchImpl,
        });
        expect(generator.label).toBe("anthropic/claude-haiku-4-5");
        await expect(generator.generate(CONTEXT)).resolves.toBe("Main St. No:1, Springfield");
        expect(JSON.parse(calls[0].body.messages[0].content).field.name).toBe("Full delivery address");
    });
});

describe("CLI providers", (): void => {
    const FAKE: string = join(__dirname, "../../fixtures/fake-cli");

    function echoed(reply: string | null): { args: string[]; input: string; cwd: string } {
        return JSON.parse(reply ?? "{}");
    }

    it("finds a CLI on PATH, and is unavailable without one", (): void => {
        expect(findOnPath("claude", FAKE)).toBe(join(FAKE, "claude"));
        expect(findOnPath("claude", "/nonexistent")).toBeUndefined();
        expect(providerAvailable(TextProvider.CODEX, { baseUrl: "" })).toBe(false);
    });

    it("lists Claude Code's aliases (Opus the default), and Codex's cached models (Sol the default)", async (): Promise<void> => {
        const claude: TextModelInfo[] = await listTextModels(TextProvider.CLAUDE_CODE, { baseUrl: "", command: join(FAKE, "claude") });
        expect(claude.map((m: TextModelInfo): string => m.id)).toEqual(["haiku", "sonnet", "opus", "fable"]);
        expect(claude.filter((m: TextModelInfo): boolean => m.default === true).map((m: TextModelInfo): string => m.id)).toEqual(["opus"]);

        const home: string = mkdtempSync(join(tmpdir(), "ibexpress-codex-home-"));
        const saved: string | undefined = process.env.CODEX_HOME;
        process.env.CODEX_HOME = home;
        try {
            const settings: { baseUrl: string; command: string } = { baseUrl: "", command: join(FAKE, "codex") };
            expect(await listTextModels(TextProvider.CODEX, settings)).toEqual([{ id: "default", name: "Codex default", default: true }]);
            writeFileSync(join(home, "config.toml"), 'model = "gpt-b"\n');
            expect(await listTextModels(TextProvider.CODEX, settings)).toEqual([{ id: "gpt-b", name: "gpt-b", default: true }]);
            writeFileSync(
                join(home, "models_cache.json"),
                JSON.stringify({
                    models: [
                        { slug: "gpt-b", display_name: "GPT-B", visibility: "list", priority: 2 },
                        { slug: "internal", display_name: "Internal", visibility: "hide", priority: 0 },
                        { slug: "gpt-a", display_name: "GPT-A", visibility: "list", priority: 1 },
                    ],
                })
            );
            expect(await listTextModels(TextProvider.CODEX, settings)).toEqual([
                { id: "gpt-a", name: "GPT-A", default: true },
                { id: "gpt-b", name: "GPT-B" },
            ]);
            writeFileSync(
                join(home, "models_cache.json"),
                JSON.stringify({
                    models: [
                        { slug: "gpt-a", display_name: "GPT-A", visibility: "list", priority: 1 },
                        { slug: "gpt-2-sol", display_name: "GPT-2-Sol", visibility: "list", priority: 2 },
                        { slug: "gpt-1-sol", display_name: "GPT-1-Sol", visibility: "list", priority: 3 },
                    ],
                })
            );
            expect((await listTextModels(TextProvider.CODEX, settings)).find((m: TextModelInfo): boolean => m.default === true)?.id).toBe("gpt-2-sol");
        } finally {
            if (saved === undefined) {
                delete process.env.CODEX_HOME;
            } else {
                process.env.CODEX_HOME = saved;
            }
            rmSync(home, { recursive: true, force: true });
        }
    });

    it("runs Claude Code in print mode with tools off, the prompt on stdin, in an empty directory", async (): Promise<void> => {
        const generator: LlmTextGenerator = new LlmTextGenerator({
            model: { provider: TextProvider.CLAUDE_CODE, model: "haiku" },
            settings: { baseUrl: "", command: join(FAKE, "claude") },
        });
        const seen: { args: string[]; input: string; cwd: string } = echoed(await generator.generate(CONTEXT));
        expect(seen.args).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "--model", "haiku", "--tools", "", "--no-session-persistence"]));
        expect(seen.args[seen.args.indexOf("--system-prompt") + 1]).toContain('"text"');
        expect(JSON.parse(seen.input).goal).toBe(CONTEXT.goal);
        expect(seen.cwd).toContain("ibexpress-claude-");
    });

    it("with a screenshot, lets Claude Code Read the files of its own temporary directory and nothing else", async (): Promise<void> => {
        const reply: string = await completeText(
            { provider: TextProvider.CLAUDE_CODE, model: "opus" },
            { baseUrl: "", command: join(FAKE, "claude") },
            "system",
            "user",
            undefined,
            [{ mimeType: "image/png", data: Buffer.from("png").toString("base64") }]
        );
        const seen: { args: string[]; input: string; cwd: string } = echoed(parseTextReply(reply));
        expect(seen.args[seen.args.indexOf("--tools") + 1]).toBe("Read");
        const allowed: string = seen.args[seen.args.indexOf("--allowedTools") + 1];
        // One rule, for the run's own (real-path) temporary directory: a Read anywhere else is refused.
        expect(allowed).toMatch(/^Read\(\/\/.*ibexpress-claude-[^/]+\/\*\*\)$/);
        expect(allowed.startsWith(`Read(//${realpathSync(tmpdir()).replace(/^\/+/, "")}/ibexpress-claude-`)).toBe(true);
        expect(readRulesFor(tmpdir())[0]).toBe(`Read(//${realpathSync(tmpdir()).replace(/^\/+/, "")}/**)`);
        expect(seen.input).toContain("./image-1.png");
    });

    it("runs codex exec read-only, without a session, reading the last message", async (): Promise<void> => {
        const generator: LlmTextGenerator = new LlmTextGenerator({
            model: { provider: TextProvider.CODEX, model: "default" },
            settings: { baseUrl: "", command: join(FAKE, "codex") },
        });
        const seen: { args: string[]; input: string; cwd: string } = echoed(await generator.generate(CONTEXT));
        expect(seen.args.slice(0, 5)).toEqual(["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only"]);
        expect(seen.args).not.toContain("-m");
        expect(seen.args.at(-1)).toBe("-");
        expect(seen.input).toContain("Full delivery address");
    });

    it("reports a failed CLI with its last error line", async (): Promise<void> => {
        await expect(
            completeText({ provider: TextProvider.CLAUDE_CODE, model: "haiku" }, { baseUrl: "", command: join(FAKE, "claude") }, "s", "FAKE_CLI_FAIL")
        ).rejects.toThrow(/claude failed: not logged in/);
    });

    it("fails one call, not the process, when a CLI exits before reading a long prompt", async (): Promise<void> => {
        // Longer than the pipe buffer: the write meets a closed pipe once the child has exited.
        const long: string = "x".repeat(200_000);
        await expect(
            completeText({ provider: TextProvider.CLAUDE_CODE, model: "haiku" }, { baseUrl: "", command: join(FAKE, "exit-early") }, "s", long)
        ).rejects.toThrow(/exit-early failed: cannot start/);
    });

    it("hands a CLI child only the environment it runs and logs in with, never the run's keys", async (): Promise<void> => {
        const leaked: string[] = ["TYPESAFE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "IRONBEE_API_KEY", "IRONBEE_OAUTH_TOKEN", "OPENROUTER_API_KEY"];
        const saved: Record<string, string | undefined> = Object.fromEntries(leaked.map((name: string): [string, string | undefined] => [name, process.env[name]]));
        for (const name of leaked) {
            process.env[name] = "leak-me";
        }
        try {
            const generator: LlmTextGenerator = new LlmTextGenerator({
                model: { provider: TextProvider.CLAUDE_CODE, model: "haiku" },
                settings: { baseUrl: "", command: join(FAKE, "claude") },
            });
            const seen: { env: string[] } = JSON.parse((await generator.generate(CONTEXT)) ?? "{}");
            expect(seen.env).toEqual(expect.arrayContaining(["PATH", "HOME"]));
            for (const name of leaked) {
                expect(seen.env).not.toContain(name);
            }
            // The whitelist itself: names and families kept, everything else dropped.
            const env: NodeJS.ProcessEnv = childEnv({
                PATH: "/bin",
                HOME: "/h",
                XDG_CONFIG_HOME: "/c",
                LC_MESSAGES: "C",
                CODEX_HOME: "/x",
                // The user's network setup travels; a gateway's credentials do not.
                HTTPS_PROXY: "http://proxy:3128",
                no_proxy: "localhost",
                NODE_EXTRA_CA_CERTS: "/ca.pem",
                SSL_CERT_FILE: "/ca.pem",
                CLAUDE_CODE_USE_BEDROCK: "1",
                AWS_PROFILE: "prod",
                ANTHROPIC_BASE_URL: "https://gw.test",
                TYPESAFE_API_KEY: "k",
                FOO: "bar",
            });
            expect(Object.keys(env).sort()).toEqual([
                "CODEX_HOME",
                "HOME",
                "HTTPS_PROXY",
                "LC_MESSAGES",
                "NODE_EXTRA_CA_CERTS",
                "PATH",
                "SSL_CERT_FILE",
                "XDG_CONFIG_HOME",
                "no_proxy",
            ]);
        } finally {
            for (const name of leaked) {
                if (saved[name] === undefined) {
                    delete process.env[name];
                } else {
                    process.env[name] = saved[name];
                }
            }
        }
    });
});
