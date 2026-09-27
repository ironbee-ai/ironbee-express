import { CandidateKind, TextCandidateSource, TextChoice, TextSource, validateValueName } from "./types";

const QUOTED: RegExp = /"([^"\n]{1,200})"|“([^”\n]{1,200})”|(?<!\w)'([^'\n]{1,200})'(?!\w)|‘([^’\n]{1,200})’/g;

/** Quoted strings in the goal, in order, without duplicates. Single quotes glued to a word ("Don't") are not quotes. */
export function goalLiterals(goal: string): string[] {
    const found: string[] = [];
    for (const m of goal.matchAll(QUOTED)) {
        const text: string = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim();
        if (text && !found.includes(text)) {
            found.push(text);
        }
    }
    return found;
}

/** What the engine reads for a supplied value: its name, its text (or that it is secret), and its description. */
function suppliedDescription(name: string, shown: string, description: string | undefined): string {
    const desc: string = description?.trim().replace(/\s+/g, " ") ?? "";
    return desc ? `${name} ${shown} — ${desc}` : `${name} ${shown}`;
}

/**
 * Values and secrets the caller supplied, each with its optional description
 * (what the value is for: "billing address", "the admin's password") so the
 * engine can match it to a field. A secret's choice carries its name and
 * description only; its text is the value itself, or the `{{secret:…}}`
 * reference DevTools resolves at the field when the run's secrets are seeded
 * there (`secretRefs`).
 */
export class SuppliedValuesSource implements TextCandidateSource {
    readonly kind: CandidateKind = CandidateKind.SUPPLIED;

    constructor(
        private readonly values: Record<string, string>,
        private readonly secrets: Record<string, string>,
        private readonly descriptions: Record<string, string> = {},
        private readonly secretRefs: Record<string, string> = {}
    ) {
        // A name is a key, a reference and a recording's handle: nothing that would need rewriting.
        for (const name of Object.keys(values)) {
            validateValueName(name, "value");
        }
        for (const name of Object.keys(secrets)) {
            validateValueName(name, "secret");
        }
    }

    candidates(): Array<Omit<TextChoice, "key">> {
        return [
            ...Object.entries(this.values).map(([name, text]: [string, string]): Omit<TextChoice, "key"> => ({
                source: TextSource.VALUE,
                name,
                description: suppliedDescription(name, `= ${JSON.stringify(text)}`, this.descriptions[name]),
                text,
            })),
            ...Object.entries(this.secrets).map(([name, text]: [string, string]): Omit<TextChoice, "key"> => ({
                source: TextSource.SECRET,
                name,
                description: suppliedDescription(name, "(secret, value hidden)", this.descriptions[name]),
                text: this.secretRefs[name] ?? text,
            })),
        ];
    }
}

export class QuotedLiteralSource implements TextCandidateSource {
    readonly kind: CandidateKind = CandidateKind.QUOTED;

    candidates(goal: string): Array<Omit<TextChoice, "key">> {
        return goalLiterals(goal).map((text: string): Omit<TextChoice, "key"> => ({
            source: TextSource.GOAL_LITERAL,
            description: `quoted in the goal: ${JSON.stringify(text)}`,
            text,
        }));
    }
}

const KEY_PREFIX: Record<TextSource, string> = {
    [TextSource.VALUE]: "value",
    [TextSource.SECRET]: "secret",
    [TextSource.GOAL_LITERAL]: "quoted",
    [TextSource.GOAL_SPAN]: "span",
    [TextSource.GENERATE]: "generate",
    [TextSource.TAKEOVER]: "takeover",
    [TextSource.USER]: "user",
    [TextSource.COMBINED]: "combined",
};

export const GENERATE_KEY: string = "GENERATE";
/** "The user types it": offered when no text model writes values and a person is there. */
export const ASK_USER_KEY: string = "ASK_USER";

/**
 * The choices of one run: every source's candidates in order, a value offered
 * once (supplied values win over goal copies of the same text; a secret's text
 * never appears as another choice; secrets are never folded together — two
 * may share a value and each is its own choice, by name), each with a stable
 * key, plus GENERATE when a generator is configured.
 */
export function buildTextChoices(
    goal: string,
    sources: TextCandidateSource[],
    generate: boolean,
    secrets: Record<string, string>,
    askUser: boolean = false
): TextChoice[] {
    const choices: TextChoice[] = [];
    const seenText: Set<string> = new Set();
    const secretTexts: Set<string> = new Set(Object.values(secrets));
    const counts: Map<string, number> = new Map();
    for (const source of sources) {
        for (const candidate of source.candidates(goal)) {
            const text: string = candidate.text ?? "";
            const norm: string = text.trim().toLowerCase();
            if (candidate.source !== TextSource.SECRET) {
                // A named value is bound by its name (its key, its description, a recording's
                // handle): never folded into another with the same text. Its text still suppresses
                // a quoted copy of it that comes later.
                if (candidate.name === undefined && seenText.has(norm)) {
                    continue;
                }
                if (secretTexts.has(text)) {
                    continue;
                }
                seenText.add(norm);
            }
            // A supplied value's key is its name (unique per prefix: names are record keys); a
            // quoted literal's is its number among its source's.
            const prefix: string = KEY_PREFIX[candidate.source];
            let name: string;
            if (candidate.name !== undefined) {
                name = candidate.name;
            } else {
                const n: number = (counts.get(prefix) ?? 0) + 1;
                counts.set(prefix, n);
                name = String(n);
            }
            choices.push({ ...candidate, key: `${prefix}:${name}` });
        }
    }
    if (generate) {
        choices.push({
            key: GENERATE_KEY,
            source: TextSource.GENERATE,
            description: "none of the above fits; write new text from the goal",
        });
    } else if (askUser) {
        choices.push({
            key: ASK_USER_KEY,
            source: TextSource.USER,
            description: "none of the above fits; ask the user to type it",
        });
    }
    return choices;
}
