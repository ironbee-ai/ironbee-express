import {
    buildTextChoices,
    GENERATE_KEY,
    goalLiterals,
    QuotedLiteralSource,
    SuppliedValuesSource,
} from "../../../src/text/candidates";
import { createTextStrategy, TextConfig } from "../../../src/text";
import { TextProvider } from "../../../src/text/providers";
import { CandidateKind, TextChoice, TextSource, TextStrategy } from "../../../src/text/types";

describe("goalLiterals", (): void => {
    it("finds straight and curly quoted strings, once each", (): void => {
        expect(goalLiterals(`Search "noise cancelling" then “Sony”, then 'Sony' again and "noise cancelling"`)).toEqual([
            "noise cancelling",
            "Sony",
        ]);
    });

    it("does not treat an apostrophe in a word as a quote pair", (): void => {
        expect(goalLiterals("Don't stop, it's fine")).toEqual([]);
    });
});

describe("SuppliedValuesSource", (): void => {
    it("shows each value's description, and types a seeded secret by reference", (): void => {
        const choices: TextChoice[] = buildTextChoices(
            "Check out",
            [
                new SuppliedValuesSource(
                    { address: "Main St. 1" },
                    { card: "4111" },
                    { address: "  the delivery address ", card: "the payment card number" },
                    { card: "{{secret:card.value}}" }
                ),
            ],
            false,
            { card: "4111" }
        );
        expect(choices.map((c: TextChoice): string => c.key)).toEqual(["value:address", "secret:card"]);
        expect(choices[0].description).toBe('address = "Main St. 1" — the delivery address');
        expect(choices[1].description).toBe("card (secret, value hidden) — the payment card number");
        expect(choices[1].text).toBe("{{secret:card.value}}");
    });
});

describe("buildTextChoices", (): void => {
    it("orders sources, keys each choice, and adds GENERATE last", (): void => {
        const choices: TextChoice[] = buildTextChoices(
            'Search "MacBook"',
            [new SuppliedValuesSource({ email: "a@b.c" }, { password: "pw" }), new QuotedLiteralSource()],
            true,
            { password: "pw" }
        );
        expect(choices.map((c: TextChoice): string => c.key)).toEqual([
            "value:email",
            "secret:password",
            "quoted:1",
            GENERATE_KEY,
        ]);
        expect(choices[1].description).not.toContain("pw");
    });

    it("offers a value once, and never a secret's text under another source", (): void => {
        const choices: TextChoice[] = buildTextChoices(
            'Log in as "a@b.c" with "pw"',
            [new SuppliedValuesSource({ email: "a@b.c" }, { password: "pw" }), new QuotedLiteralSource()],
            false,
            { password: "pw" }
        );
        expect(choices.map((c: TextChoice): TextSource => c.source)).toEqual([TextSource.VALUE, TextSource.SECRET]);
    });

    it("offers every secret by name, two with the same value included, and carries the name on the choice", (): void => {
        const secrets: Record<string, string> = { password: "pw", confirm: "pw" };
        const choices: TextChoice[] = buildTextChoices("Sign up", [new SuppliedValuesSource({ "my.email": "a@b.c" }, secrets)], false, secrets);
        expect(choices.map((c: TextChoice): string => c.key)).toEqual(["value:my.email", "secret:password", "secret:confirm"]);
        expect(choices.map((c: TextChoice): string | undefined => c.name)).toEqual(["my.email", "password", "confirm"]);
    });

    it("keeps two named values with the same text apart, each under its own name", (): void => {
        const choices: TextChoice[] = buildTextChoices(
            'Ship to "Paris"',
            [new SuppliedValuesSource({ billing_city: "Paris", shipping_city: "paris" }, {}), new QuotedLiteralSource()],
            false,
            {}
        );
        // Both names are offered; the quoted copy that follows is still folded into them.
        expect(choices.map((c: TextChoice): string => c.key)).toEqual(["value:billing_city", "value:shipping_city"]);
    });

    it("numbers quoted literals in order; a supplied value's key is its name", (): void => {
        const choices: TextChoice[] = buildTextChoices('Search "A" then "B"', [new SuppliedValuesSource({ q: "x" }, {}), new QuotedLiteralSource()], false, {});
        expect(choices.map((c: TextChoice): string => c.key)).toEqual(["value:q", "quoted:1", "quoted:2"]);
    });

    it("refuses a value or secret name that could not be a key", (): void => {
        expect((): unknown => new SuppliedValuesSource({ "my pw": "x" }, {})).toThrow(/value name "my pw"/);
        expect((): unknown => new SuppliedValuesSource({}, { "a/b": "x" })).toThrow(/secret name "a\/b"/);
        expect((): unknown => new SuppliedValuesSource({ ok_name: "x" }, { "ok.name-2": "y" })).not.toThrow();
    });
});

describe("createTextStrategy", (): void => {
    const config: TextConfig = {
        candidates: [CandidateKind.QUOTED],
        providers: {
            [TextProvider.ANTHROPIC]: { baseUrl: "http://a" },
            [TextProvider.OPENAI]: { baseUrl: "http://o" },
            [TextProvider.OPENROUTER]: { apiKey: "k", baseUrl: "http://r" },
            [TextProvider.CLAUDE_CODE]: { baseUrl: "" },
            [TextProvider.CODEX]: { baseUrl: "" },
        },
    };

    it("always offers supplied values first, then the configured sources", (): void => {
        const strategy: TextStrategy = createTextStrategy('Search "Sony"', config, {
            values: { email: "a@b.c" },
            secrets: {},
        });
        expect(strategy.choices.map((c: TextChoice): TextSource => c.source)).toEqual([
            TextSource.VALUE,
            TextSource.GOAL_LITERAL,
        ]);
        expect(strategy.generator).toBeUndefined();
    });

    it("refuses a text model whose provider has no key, and offers GENERATE with one", (): void => {
        expect((): TextStrategy =>
            createTextStrategy("x", { ...config, model: { provider: TextProvider.OPENAI, model: "gpt-4o-mini" } }, { values: {}, secrets: {} })
        ).toThrow(/unavailable: set OPENAI_API_KEY/);
        const strategy: TextStrategy = createTextStrategy(
            "x",
            { ...config, model: { provider: TextProvider.OPENROUTER, model: "inception/mercury-2.5" } },
            { values: {}, secrets: {} }
        );
        expect(strategy.generator?.label).toBe("openrouter/inception/mercury-2.5");
        expect(strategy.choices.at(-1)?.key).toBe(GENERATE_KEY);
    });
});
