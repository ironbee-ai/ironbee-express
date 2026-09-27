import { maskSecrets, maskSecretsEncoded, textRefOf, visibleText, withoutText } from "../../../src/text/mask";
import { TextChoice, TextSource } from "../../../src/text/types";

describe("maskSecrets", (): void => {
    it("masks secrets everywhere in a nested value, longest first", (): void => {
        expect(
            maskSecrets(
                { text: "Demo: a / pw123", controls: [{ context: "pw123!" }], n: 1 },
                { short: "pw", long: "pw123" }
            )
        ).toEqual({ text: "Demo: a / [secret:long]", controls: [{ context: "[secret:long]!" }], n: 1 });
    });

    it("is the identity without secrets", (): void => {
        const value: { a: string } = { a: "x" };
        expect(maskSecrets(value, {})).toBe(value);
    });
});

describe("visibleText / withoutText", (): void => {
    const secret: TextChoice = { key: "secret:password", name: "password", source: TextSource.SECRET, description: "d", text: "pw" };
    const value: TextChoice = { key: "value:email", name: "email", source: TextSource.VALUE, description: "d", text: "a@b.c" };

    it("shows secrets by name only", (): void => {
        expect(visibleText(secret, "pw")).toBe("<secret password>");
        expect(visibleText(value, "a@b.c")).toBe("a@b.c");
    });

    it("refers to a value or a secret by the name it was supplied under, never by parsing its key", (): void => {
        expect(textRefOf(secret, "pw")).toEqual({ source: TextSource.SECRET, name: "password" });
        expect(textRefOf(value, "a@b.c")).toEqual({ source: TextSource.VALUE, name: "email", text: "a@b.c" });
        const quoted: TextChoice = { key: "quoted:1", source: TextSource.GOAL_LITERAL, description: "d", text: "MacBook" };
        expect(textRefOf(quoted, "MacBook")).toEqual({ source: TextSource.GOAL_LITERAL, text: "MacBook" });
    });

    it("strips the text of every choice", (): void => {
        expect(JSON.stringify(withoutText([secret, value]))).not.toMatch(/"text"/);
    });
});

describe("maskSecretsEncoded", (): void => {
    it("masks a secret as a form body, a JSON body or HTML carries it too", (): void => {
        const secrets: Record<string, string> = { password: 'p@ss w"<rd' };
        const out: Record<string, string> = maskSecretsEncoded(
            {
                raw: 'p@ss w"<rd',
                form: "user=a&password=p%40ss+w%22%3Crd",
                uri: "p%40ss%20w%22%3Crd",
                json: '{"password":"p@ss w\\"<rd"}',
                html: '<input value="p@ss w&quot;&lt;rd">',
            },
            secrets
        );
        expect(Object.values(out).join(" ")).not.toMatch(/p@ss|p%40ss/);
        expect(out.form).toBe("user=a&password=[secret:password]");
    });

    it("masks the form-urlencoded shape a browser submits, which escapes more than encodeURIComponent", (): void => {
        // `!` (and `'()~`) survive encodeURIComponent but not a form submission; a space becomes `+`.
        const out: Record<string, string> = maskSecretsEncoded(
            {
                body: "username=x&password=Passw0rd%21",
                query: "https://shop.test/login?pw=Passw0rd%21&pin=p%40ss+word",
                plain: "Passw0rd! and p@ss word",
            },
            { password: "Passw0rd!", pin: "p@ss word" }
        );
        expect(out.body).toBe("username=x&password=[secret:password]");
        expect(out.query).toBe("https://shop.test/login?pw=[secret:password]&pin=[secret:pin]");
        expect(out.plain).toBe("[secret:password] and [secret:pin]");
    });

    it("masks the quote escapes the common HTML escapers write", (): void => {
        const out: Record<string, string> = maskSecretsEncoded(
            {
                react: "value=\"it&#x27;s &quot;ok&quot;\"",
                template: "it&#39;s &#34;ok&#34;",
                plain: "it's \"ok\"",
            },
            { pw: "it's \"ok\"" }
        );
        expect(out.react).toBe("value=\"[secret:pw]\"");
        expect(out.template).toBe("[secret:pw]");
        expect(out.plain).toBe("[secret:pw]");
    });

    it("masks a value the page read gave back reflowed or cut short, and nothing that merely starts like it", (): void => {
        const token: string = "tok_" + "a1b2c3d4".repeat(32) + "zz";
        const pem: string = "-----BEGIN KEY-----\nMIIEabc def\n-----END KEY-----";
        const out: Record<string, string> = maskSecretsEncoded(
            {
                // A field value DevTools clipped to 199 chars + "…".
                field: `${token.slice(0, 199)}…`,
                // A multi-line value read back as one line.
                area: "-----BEGIN KEY----- MIIEabc def -----END KEY-----",
                // Cut at the end of the page text.
                text: `Your token is ${token.slice(0, 40)}`,
                // The first 16 characters followed by other text: not a cut value.
                other: `${token.slice(0, 20)} and more`,
            },
            { token, pem }
        );
        expect(out.field).toBe("[secret:token]…");
        expect(out.area).toBe("[secret:pem]");
        expect(out.text).toBe("Your token is [secret:token]");
        expect(out.other).toBe(`${token.slice(0, 20)} and more`);
    });

    it("masks a value once, even one that is a part of its own marker", (): void => {
        // A plain value has the same shape under every encoding; `admin=admin` or a value
        // containing `secret` must not be re-masked inside `[secret:name]`.
        const out: Record<string, string> = maskSecretsEncoded(
            { hint: "login hint: secret", user: "admin logged in as admin" },
            { pw: "secret", admin: "admin" }
        );
        expect(out.hint).toBe("login hint: [secret:pw]");
        expect(out.user).toBe("[secret:admin] logged in as [secret:admin]");
    });

    it("masks a longer value cut short before a shorter value it starts with can split it", (): void => {
        const secrets: Record<string, string> = {
            user: "admin.operator@example.com",
            password: "admin.operator@example.com#Pa55-word-9981",
        };
        const out: Record<string, string> = maskSecretsEncoded(
            { clipped: "hint: admin.operator@example.com#Pa55-wo…", ended: "hint: admin.operator@example.com#Pa55-wo" },
            secrets
        );
        expect(out.clipped).toBe("hint: [secret:password]…");
        expect(out.ended).toBe("hint: [secret:password]");
        expect(JSON.stringify(out)).not.toContain("#Pa55");
        // The shorter value alone is still its own.
        expect(maskSecretsEncoded("as admin.operator@example.com today", secrets)).toBe("as [secret:user] today");
        // …also at the end of the text or before a cut mark: a whole value is not a longer one cut short.
        expect(maskSecretsEncoded("Signed in as admin.operator@example.com", secrets)).toBe("Signed in as [secret:user]");
        expect(maskSecretsEncoded('textbox "Email": admin.operator@example.com…', secrets)).toBe('textbox "Email": [secret:user]…');
        // A user name that repeats its own start is not split under the password's name.
        const repeating: Record<string, string> = { user: "testtesttesttesttest", password: "testtesttesttesttest123" };
        expect(maskSecretsEncoded("login: testtesttesttesttest", repeating)).toBe("login: [secret:user]");
        expect(maskSecretsEncoded("login: testtesttesttesttest…", repeating)).toBe("login: [secret:user]…");
    });
});

describe("maskSecretsEncoded on DevTools' own cuts", (): void => {
    it("masks a value cut short where DevTools' text or HTML read notes its truncation", (): void => {
        const secrets: Record<string, string> = { pw: "abcdefghijklmnopqrstuvwxyz0123" };
        expect(maskSecretsEncoded("Your key: abcdefghijklmnopqrst\n[Output truncated due to size limits]", secrets)).toBe(
            "Your key: [secret:pw]\n[Output truncated due to size limits]"
        );
        expect(maskSecretsEncoded("<p>abcdefghijklmnopqrst\n<!-- Output truncated due to size limits -->", secrets)).toBe(
            "<p>[secret:pw]\n<!-- Output truncated due to size limits -->"
        );
    });
});
