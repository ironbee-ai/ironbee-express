/**
 * Coding-agent CLIs as text models: the Claude Code CLI (`claude`) and the
 * Codex CLI (`codex`), each available when installed. They authenticate with
 * their own login — no key is read here. One completion runs the CLI once in
 * its non-interactive mode, in an empty temporary directory (no project files
 * to read), with its tools off — Claude Code gets Read, for the screenshot
 * files in that directory only, when images come with the prompt — or in a
 * read-only sandbox (Codex), and without saving a session.
 */

import { execFile } from "child_process";
import { accessSync, constants, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, delimiter, join } from "path";
import type { TextImage } from "./providers";

/** A CLI run is a whole agent start-up: allow it well over an API call. */
const CLI_TIMEOUT_MS: number = 120_000;
const MAX_OUTPUT_BYTES: number = 1024 * 1024;

/** Claude Code's model aliases: each is the latest model of its family. Opus is picked unless another is chosen. */
export const CLAUDE_CODE_MODELS: Array<{ id: string; name: string; default?: boolean }> = [
    { id: "haiku", name: "Haiku" },
    { id: "sonnet", name: "Sonnet" },
    { id: "opus", name: "Opus", default: true },
    { id: "fable", name: "Fable" },
];

/** Codex: the model its own configuration names (no `-m`). Still accepted from older saved settings. */
export const CODEX_DEFAULT_MODEL: string = "default";

/** The Codex family picked unless another model is chosen: its newest listed model. */
const CODEX_PREFERRED_FAMILY: RegExp = /-sol$/i;

/**
 * Codex's models. The CLI has no list command, but it keeps the list it
 * fetched in `$CODEX_HOME/models_cache.json` (default `~/.codex`): the ones it
 * shows, in its own order. The newest Sol model is marked the default (else
 * the first listed). Without the cache, only the model its configuration
 * names — or, with none, Codex's own default.
 */
export function codexModels(home: string = process.env.CODEX_HOME ?? join(homedir(), ".codex")): Array<{ id: string; name: string; default?: boolean }> {
    const models: Array<{ id: string; name: string; default?: boolean }> = [];
    try {
        const cache: { models?: Array<{ slug?: string; display_name?: string; visibility?: string; priority?: number }> } = JSON.parse(
            readFileSync(join(home, "models_cache.json"), "utf-8")
        );
        const listed: Array<{ slug?: string; display_name?: string; visibility?: string; priority?: number }> = (cache.models ?? [])
            .filter((m: { slug?: string; visibility?: string }): boolean => typeof m.slug === "string" && m.visibility !== "hide")
            .sort((a: { priority?: number }, b: { priority?: number }): number => (a.priority ?? 0) - (b.priority ?? 0));
        for (const m of listed) {
            models.push({ id: m.slug!, name: m.display_name ?? m.slug! });
        }
    } catch {
        // no cache yet (Codex never ran)
    }
    if (models.length === 0) {
        let configured: string | undefined;
        try {
            configured = /^\s*model\s*=\s*"([^"]+)"/m.exec(readFileSync(join(home, "config.toml"), "utf-8"))?.[1];
        } catch {
            // no config: Codex's built-in default
        }
        return [configured ? { id: configured, name: configured, default: true } : { id: CODEX_DEFAULT_MODEL, name: "Codex default", default: true }];
    }
    const preferred: { id: string; name: string; default?: boolean } =
        models.find((m: { id: string }): boolean => CODEX_PREFERRED_FAMILY.test(m.id)) ?? models[0];
    preferred.default = true;
    return models;
}

/** The executable's path on PATH, or undefined. */
export function findOnPath(command: string, path: string | undefined = process.env.PATH): string | undefined {
    for (const dir of (path ?? "").split(delimiter).filter(Boolean)) {
        const candidate: string = join(dir, command);
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch {
            // not here
        }
    }
    return undefined;
}

/**
 * Environment names a CLI child gets as they are: where it runs, who runs it, how it reaches the
 * network (the user's proxy and CA setup, not the run's) and where it finds its own login.
 */
const CHILD_ENV_NAMES: Set<string> = new Set([
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "TERM",
    "LANG",
    "LC_ALL",
    "SHELL",
    "USER",
    "LOGNAME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
]);
/** … and these families (locale, XDG base directories). */
const CHILD_ENV_PREFIXES: string[] = ["LC_", "XDG_"];

/**
 * The environment a CLI child runs with: what it needs to run and to find its own login, and
 * nothing of this process's — the run's keys (`TYPESAFE_*`, `ANTHROPIC_*`, `OPENAI_*`,
 * `IRONBEE_*`, …) are loaded into `process.env`, the prompt carries untrusted page text, and Codex's
 * read-only sandbox still runs commands: a `printenv` typed back into the page would leak them.
 * So the children run on their own OAuth login only: a Claude Code pointed at Bedrock / Vertex / a
 * gateway (`CLAUDE_CODE_USE_BEDROCK`, `AWS_*`, `ANTHROPIC_BASE_URL`, …) is not handed those — they can
 * carry credentials.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined && (CHILD_ENV_NAMES.has(name) || CHILD_ENV_PREFIXES.some((prefix: string): boolean => name.startsWith(prefix)))) {
            out[name] = value;
        }
    }
    return out;
}

function run(command: string, args: string[], input: string, cwd: string): Promise<string> {
    return new Promise<string>((resolve: (out: string) => void, reject: (err: Error) => void): void => {
        const child: ReturnType<typeof execFile> = execFile(
            command,
            args,
            { cwd, timeout: CLI_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, env: childEnv() },
            (err: Error | null, stdout: string, stderr: string): void => {
                if (err) {
                    const detail: string = (stderr || err.message).trim().split("\n").slice(-3).join(" ").slice(0, 300);
                    reject(new Error(`${command.split("/").pop()} failed: ${detail}`));
                    return;
                }
                resolve(stdout);
            }
        );
        // A child that exits before draining a long prompt (a start-up failure) gives the pipe
        // EPIPE; unheard, that is an uncaught exception. The exit callback reports why.
        child.stdin?.on("error", (): void => undefined);
        child.stdin?.end(input);
    });
}

/** Images written into a run's own directory, for a CLI to read. */
function writeImages(dir: string, images: TextImage[]): string[] {
    return images.map((image: TextImage, i: number): string => {
        const file: string = join(dir, `image-${i + 1}.${image.mimeType.split("/")[1] ?? "png"}`);
        writeFileSync(file, Buffer.from(image.data, "base64"));
        return file;
    });
}

/**
 * Claude Code's permission rules that let it read the files under `dir` and nothing else: in print
 * mode a Read no rule allows is refused, not asked about. `//` starts an absolute path in a rule;
 * the real path, because the temp dir may sit behind a symlink (macOS) and the tool resolves it.
 */
export function readRulesFor(dir: string): string[] {
    return [`Read(//${realpathSync(dir).replace(/^\/+/, "")}/**)`];
}

/**
 * Claude Code in print mode: no MCP servers, no saved session, and no tools — but Read when images
 * come with the prompt: they are files in the run's own empty directory, and Read is how it sees
 * them, allowed for that directory only (the prompt carries untrusted page text, which must not be
 * able to send it reading anything else).
 */
export async function completeWithClaudeCode(command: string, model: string, system: string, user: string, images: TextImage[] = []): Promise<string> {
    const dir: string = mkdtempSync(join(tmpdir(), "ibexpress-claude-"));
    try {
        const files: string[] = writeImages(dir, images);
        const prompt: string = files.length
            ? `${user}\n\nImages (read each with the Read tool before answering): ${files.map((f: string): string => `./${basename(f)}`).join(", ")}`
            : user;
        const out: string = await run(
            command,
            [
                "-p",
                "--output-format",
                "json",
                "--model",
                model,
                "--system-prompt",
                system,
                "--tools",
                files.length ? "Read" : "",
                ...(files.length ? ["--allowedTools", readRulesFor(dir).join(",")] : []),
                "--strict-mcp-config",
                "--no-session-persistence",
            ],
            prompt,
            dir
        );
        const parsed: { result?: unknown; is_error?: boolean } = JSON.parse(out);
        if (parsed.is_error || typeof parsed.result !== "string") {
            throw new Error(`claude returned no result: ${String(parsed.result ?? "").slice(0, 200)}`);
        }
        return parsed.result;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** Codex exec: read-only sandbox, no saved session; the last message is read from a file. */
export async function completeWithCodex(command: string, model: string, system: string, user: string, images: TextImage[] = []): Promise<string> {
    const dir: string = mkdtempSync(join(tmpdir(), "ibexpress-codex-"));
    const last: string = join(dir, "last-message.txt");
    try {
        const files: string[] = writeImages(dir, images);
        await run(
            command,
            [
                "exec",
                "--skip-git-repo-check",
                "--ephemeral",
                "--sandbox",
                "read-only",
                "-o",
                last,
                ...(model && model !== CODEX_DEFAULT_MODEL ? ["-m", model] : []),
                ...files.flatMap((f: string): string[] => ["-i", f]),
                "-",
            ],
            `${system}\n\n${user}`,
            dir
        );
        return readFileSync(last, "utf-8");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
