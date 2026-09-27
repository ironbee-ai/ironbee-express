/**
 * Text the snapshot cuts to fit ends in "…" — the mark `maskSecretsEncoded` reads as "a value cut
 * short", so a secret the page shows across the cut is still masked.
 */

import { DevtoolsClient } from "../../../src/devtools/client";
import { cutText } from "../../../src/devtools-plugin/frames";
import { maskSecretsEncoded } from "../../../src/text/mask";

describe("cutText", (): void => {
    it("leaves text that fits, and ends a cut one with …", (): void => {
        expect(cutText("short", 10)).toBe("short");
        expect(cutText("0123456789abc", 10)).toBe("012345678…");
        expect(cutText("0123456789abc", 10)).toHaveLength(10);
        expect(cutText("anything", 0)).toBe("");
    });

    it("lets a secret cut at the page text's end, before a frame section, be masked", (): void => {
        const secret: string = "Zq8#kLm2!vRt5$wXy7";
        // 16 of its 18 characters fit before the cut (a cut value is recognised from 16 on).
        const page: string = cutText(`Your temp password is ${secret}`, 39) + "\n\n[frame: chat]\nHello";
        expect(page).not.toContain(secret);
        expect(maskSecretsEncoded(page, { temp: secret })).toBe("Your temp password is [secret:temp]…\n\n[frame: chat]\nHello");
    });
});

describe("DevtoolsClient.pageText", (): void => {
    it("turns DevTools' truncation note into the cut mark, so a value straddling the cut is masked", async (): Promise<void> => {
        const secret: string = "Zq8#kLm2!vRt5$wXy7PqRsT";
        class TextClient extends DevtoolsClient {
            override async call<T>(): Promise<T> {
                return { output: `${"x".repeat(40)} ${secret.slice(0, 18)}\n[Output truncated due to size limits]` } as T;
            }
        }
        const text: string = await new TextClient({ baseUrl: "http://127.0.0.1:1" }).pageText(60);
        expect(text.endsWith("…")).toBe(true);
        expect(maskSecretsEncoded(text, { temp: secret })).not.toContain(secret.slice(0, 18));
    });
});
