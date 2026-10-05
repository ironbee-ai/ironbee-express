import { recordedTabIndex, Replayer, ReplayResult } from "../../../src/scenario/replayer";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StepEvent, StepMode } from "../../../src/agent/agent";
import { Operation, UserActionKind } from "../../../src/agent/policy";
import { ActRequest, ActResult, ControlAction, ControlOperation, ControlSnapshot } from "../../../src/devtools/types";
import { describeTarget, findTarget, lookupTarget, TargetDescriptor, TargetLookup } from "../../../src/scenario/descriptor";
import { recordSteps } from "../../../src/scenario/recording";
import { ReidentifyRequest, Reidentified, TargetReidentifier } from "../../../src/scenario/reidentify";
import { sleep } from "../../../src/util/time";
import { missingSecrets, resolveTextRef } from "../../../src/scenario/replayer";
import { RecordingCache } from "../../../src/scenario/cache";
import { promptHash, ScenarioError, ScenarioStore, validateScenarioName } from "../../../src/scenario/store";
import { RecordedStep, Recording, Scenario, SCENARIO_FORMAT_VERSION } from "../../../src/scenario/types";
import { buildTextChoices, SuppliedValuesSource } from "../../../src/text/candidates";
import { maskSecrets } from "../../../src/text/mask";
import { TextSource, TextStrategy } from "../../../src/text/types";
import { control, productControls, snapshot } from "../../helpers/fixtures";
import { SiteClient } from "../../helpers/site-client";

describe("descriptors", (): void => {
    it("find the same product's button on a fresh page, by context", (): void => {
        const first = snapshot(1, productControls(4));
        const sony = first.controls.find((c): boolean => (c.context ?? "").includes("Sony"))!;
        const d: TargetDescriptor = describeTarget(sony, first);
        expect(d).toEqual({ role: "button", name: "Add to cart", context: "Sony WH-1000XM5 headphones", ordinal: 0 });

        // Next load: new ids, a reordered grid.
        const next = snapshot(2, [...productControls(4)].reverse().map((c, i) => ({ ...c, id: 500 + i })));
        expect(findTarget(d, next)?.context).toContain("Sony");
    });

    it("tolerate a changed badge in the context, but not an ambiguous match", (): void => {
        const d: TargetDescriptor = { role: "button", name: "Add to cart", context: "Sony WH-1000XM5", ordinal: 0 };
        const one = snapshot(1, [
            control(1, "button", "Add to cart", [ControlOperation.CLICK], { context: "Sony WH-1000XM5 · Save 11%" }),
            control(2, "button", "Add to cart", [ControlOperation.CLICK], { context: "MacBook Pro" }),
        ]);
        expect(findTarget(d, one)?.id).toBe(1);
        const two = snapshot(1, [
            control(1, "button", "Add to cart", [ControlOperation.CLICK], { context: "Sony WH-1000XM5 black" }),
            control(2, "button", "Add to cart", [ControlOperation.CLICK], { context: "Sony WH-1000XM5 silver" }),
        ]);
        expect(findTarget(d, two)).toBeUndefined();
    });

    it("use position among identical controls without context", (): void => {
        const s = snapshot(1, [
            control(1, "link", "Edit", [ControlOperation.CLICK]),
            control(2, "link", "Edit", [ControlOperation.CLICK]),
        ]);
        expect(findTarget({ role: "link", name: "Edit", ordinal: 1 }, s)?.id).toBe(2);
        expect(findTarget({ role: "link", name: "Delete", ordinal: 0 }, s)).toBeUndefined();
    });

    it("finds a control without context among its bare twins, not among twins that have one", (): void => {
        const s = snapshot(1, [
            control(1, "button", "Remove", [ControlOperation.CLICK], { context: "Item A" }),
            control(2, "button", "Remove", [ControlOperation.CLICK]),
        ]);
        const d: TargetDescriptor = describeTarget(s.controls[1], s);
        expect(d).toEqual({ role: "button", name: "Remove", ordinal: 0 });
        expect(findTarget(d, s)?.id).toBe(2);
    });

    it("leave a changed price beside the recorded control to the engine: the same-named controls are its candidates", (): void => {
        const d: TargetDescriptor = { role: "button", name: "Add to cart", context: "Aurora Headphones $129.00", ordinal: 0 };
        const s = snapshot(1, [
            control(1, "button", "Add to cart", [ControlOperation.CLICK], { context: "Nimbus Speaker $59.00" }),
            control(2, "button", "Add to cart", [ControlOperation.CLICK], { context: "Aurora Headphones $119.00" }),
            control(3, "link", "Cart", [ControlOperation.CLICK]),
        ]);
        const found: TargetLookup = lookupTarget(d, s);
        expect(found.control).toBeUndefined();
        expect(found.candidates.map((c): number => c.id)).toEqual([1, 2]);
        expect(findTarget(d, s)).toBeUndefined();
        // What the descriptor settles itself needs no reading: an exact context, a badge, nothing named so.
        expect(lookupTarget({ ...d, context: "Aurora Headphones $119.00" }, s)).toEqual({ control: s.controls[1], candidates: [] });
        expect(lookupTarget({ ...d, context: "Aurora Headphones" }, s)).toEqual({ control: s.controls[1], candidates: [] });
        expect(lookupTarget({ role: "button", name: "Checkout", ordinal: 0 }, s)).toEqual({ candidates: [] });
    });

    it("leave twins that appeared beside a control recorded without context to the engine, not take the first", (): void => {
        // Unique when recorded (no context); now a promotion above it has the same button.
        const d: TargetDescriptor = { role: "button", name: "Add to cart", ordinal: 0 };
        const s = snapshot(1, [
            control(1, "button", "Add to cart", [ControlOperation.CLICK], { context: "Deal of the day: Nimbus Speaker" }),
            control(2, "button", "Add to cart", [ControlOperation.CLICK], { context: "Aurora Headphones" }),
        ]);
        expect(lookupTarget(d, s)).toEqual({ candidates: s.controls });
        expect(findTarget(d, s)).toBeUndefined();
        // Still one of its kind: it is the one.
        const one = snapshot(2, [control(2, "button", "Add to cart", [ControlOperation.CLICK])]);
        expect(lookupTarget(d, one)).toEqual({ control: one.controls[0], candidates: [] });
    });
});

describe("a control the page changed around", (): void => {
    const limits: { maxControls: number; maxTextChars: number } = { maxControls: 50, maxTextChars: 1_000 };
    const plainText: TextStrategy = { choices: [], secrets: {} };
    const aurora: TargetDescriptor = { role: "button", name: "Add to cart", context: "Aurora Headphones $129.00", ordinal: 0 };

    function shop(auroraContext: string): Record<string, { controls: ReturnType<typeof control>[]; text?: string; links?: Record<string, string> }> {
        return {
            products: {
                controls: [
                    control(1, "button", "Add to cart", [ControlOperation.CLICK], { context: "Nimbus Speaker $59.00" }),
                    control(2, "button", "Add to cart", [ControlOperation.CLICK], { context: auroraContext }),
                ],
                links: { "Add to cart": "cart" },
            },
            cart: { controls: [], text: "Your cart" },
        };
    }

    const recording: Recording = {
        promptHash: "h",
        recordedAt: "",
        engine: "e",
        elapsedMs: 0,
        steps: [{ operation: Operation.CLICK, target: aurora, path: "/products" }],
    };

    function reidentifier(answer: (request: ReidentifyRequest) => Reidentified): { asked: ReidentifyRequest[]; reidentifier: TargetReidentifier } {
        const asked: ReidentifyRequest[] = [];
        return {
            asked,
            reidentifier: {
                reidentify: async (request: ReidentifyRequest): Promise<Reidentified> => {
                    asked.push(request);
                    return answer(request);
                },
            },
        };
    }

    it("is acted on once the engine finds it again, and the step carries its new descriptor", async (): Promise<void> => {
        const client: SiteClient = new SiteClient(shop("Aurora Headphones $119.00"), "products");
        const engine = reidentifier((r: ReidentifyRequest): Reidentified => ({ control: r.candidates.find((c): boolean => c.id === 2), probability: 0.97, ms: 12 }));
        const events: StepEvent[] = [];
        const replay: ReplayResult = await new Replayer({
            client,
            limits,
            text: plainText,
            settledMs: 50,
            reidentifier: engine.reidentifier,
            onStep: (e: StepEvent): void => {
                events.push(e);
            },
        }).run(recording);
        expect(replay.completed).toBe(true);
        expect(client.acts.filter((a: ActRequest): boolean => a.action === ControlAction.CLICK).map((a): number | undefined => a.controlId)).toEqual([2]);
        expect(engine.asked).toHaveLength(1);
        expect(engine.asked[0]).toMatchObject({ operation: Operation.CLICK, recorded: aurora, recordedPath: "/products" });
        expect(engine.asked[0].candidates.map((c): number => c.id)).toEqual([1, 2]);
        expect(replay.reidentified).toBe(1);
        expect(replay.reidentifyAsks).toBe(1);
        expect(events[0]).toMatchObject({
            mode: StepMode.REPLAY,
            executed: true,
            decisionMs: 12,
            targetDescriptor: { role: "button", name: "Add to cart", context: "Aurora Headphones $119.00", ordinal: 0 },
            reidentified: { from: 'button "Add to cart" (Aurora Headphones $129.00)', probability: 0.97 },
        });
        // The new descriptor is what a passed run records; the healing engine would read the note.
        expect(recordSteps(events)[0].target?.context).toBe("Aurora Headphones $119.00");
        expect(replay.history[0].note).toMatch(/page changed around the recorded button "Add to cart"/);
    });

    it("diverges as before when the engine sees none of them as it, asking once per set of candidates", async (): Promise<void> => {
        const client: SiteClient = new SiteClient(shop("Aurora Headphones Gen 2 $249.00"), "products");
        const engine = reidentifier((): Reidentified => ({ probability: 0.91, ms: 8 }));
        const replay: ReplayResult = await new Replayer({ client, limits, text: plainText, settledMs: 50, reidentifier: engine.reidentifier }).run(recording);
        expect(replay.completed).toBe(false);
        expect(replay.reason).toMatch(/not on \/products \(the page settled without it for 50 ms; the engine saw none of the 2 controls named so as it \(p=0\.91\)\)/);
        expect(engine.asked).toHaveLength(1);
        expect(replay.reidentified).toBe(0);
        expect(replay.reidentifyAsks).toBe(1);
        expect(client.acts.filter((a: ActRequest): boolean => a.action === ControlAction.CLICK)).toHaveLength(0);
    });

    it("does not act on a control the engine is unsure of", async (): Promise<void> => {
        const client: SiteClient = new SiteClient(shop("Aurora Headphones $119.00"), "products");
        const engine = reidentifier((r: ReidentifyRequest): Reidentified => ({ unsure: r.candidates[1], probability: 0.55, ms: 8 }));
        const replay: ReplayResult = await new Replayer({ client, limits, text: plainText, settledMs: 50, reidentifier: engine.reidentifier }).run(recording);
        expect(replay.completed).toBe(false);
        expect(replay.reason).toMatch(/the engine was not sure it is \[2\] button "Add to cart" \(Aurora Headphones \$119\.00\) \(p=0\.55\)/);
        expect(client.acts.filter((a: ActRequest): boolean => a.action === ControlAction.CLICK)).toHaveLength(0);
    });

    it("diverges without a question when no reidentifier is given", async (): Promise<void> => {
        const client: SiteClient = new SiteClient(shop("Aurora Headphones $119.00"), "products");
        const replay: ReplayResult = await new Replayer({ client, limits, text: plainText, settledMs: 50 }).run(recording);
        expect(replay.completed).toBe(false);
        expect(replay.reason).toMatch(/not on \/products \(the page settled without it for 50 ms\)$/);
        expect(replay.reidentifyAsks).toBe(0);
    });

    it("shows the engine the masked page: a secret beside a candidate never reaches it", async (): Promise<void> => {
        const secretText: TextStrategy = {
            choices: buildTextChoices("g", [new SuppliedValuesSource({}, { key: "p@ss" })], false, { key: "p@ss" }),
            secrets: { key: "p@ss" },
        };
        const client: SiteClient = new SiteClient(shop("Aurora Headphones $119.00 · coupon p@ss"), "products");
        const engine = reidentifier((): Reidentified => ({ probability: 0.9, ms: 1 }));
        await new Replayer({ client, limits, text: secretText, settledMs: 50, reidentifier: engine.reidentifier }).run(recording);
        expect(engine.asked).toHaveLength(1);
        expect(JSON.stringify(engine.asked[0])).not.toContain("p@ss");
        expect(engine.asked[0].candidates[1].context).toContain("[secret:key]");
    });
});

describe("recordSteps", (): void => {
    const base: Omit<StepEvent, "operation" | "executed"> = {
        step: 1,
        mode: StepMode.ENGINE,
        elapsedMs: 0,
        confidence: 1,
        decisionMs: 0,
        operationProbabilities: {},
        url: "https://site.test/checkout?x=1",
    };
    const field: TargetDescriptor = { role: "textbox", name: "Address", ordinal: 0 };

    it("keeps executed actions, drops waits and refusals, collapses retyping", (): void => {
        const steps: StepEvent[] = [
            { ...base, operation: Operation.WAIT, executed: true },
            { ...base, operation: Operation.CLICK, executed: false, targetDescriptor: field },
            { ...base, operation: Operation.TYPE_TEXT, executed: true, targetDescriptor: field, textRef: { source: TextSource.GOAL_SPAN, text: "Mas" } },
            { ...base, operation: Operation.TYPE_TEXT, executed: true, targetDescriptor: field, textRef: { source: TextSource.GOAL_SPAN, text: "Maslak" } },
            { ...base, operation: Operation.SCROLL_DOWN, executed: true },
            { ...base, operation: Operation.DONE, executed: true },
        ];
        const recorded: RecordedStep[] = recordSteps(steps);
        expect(recorded).toEqual([
            { operation: Operation.TYPE_TEXT, target: field, text: { source: TextSource.GOAL_SPAN, text: "Maslak" }, path: "/checkout" },
            { operation: Operation.SCROLL_DOWN, path: "/checkout" },
        ]);
    });
});

describe("text on replay", (): void => {
    const text: TextStrategy = {
        choices: buildTextChoices("g", [new SuppliedValuesSource({ email: "new@b.c" }, { password: "pw2" })], false, {
            password: "pw2",
        }),
        secrets: { password: "pw2" },
    };

    it("takes values and secrets from THIS run by name, other text as recorded", (): void => {
        expect(resolveTextRef({ source: TextSource.VALUE, name: "email", text: "old@b.c" }, text)).toBe("new@b.c");
        expect(resolveTextRef({ source: TextSource.SECRET, name: "password" }, text)).toBe("pw2");
        expect(resolveTextRef({ source: TextSource.GOAL_SPAN, text: "Maslak" }, text)).toBe("Maslak");
        // What the text model typed while it had the controls is replayed as recorded.
        expect(resolveTextRef({ source: TextSource.TAKEOVER, text: "34 Main St" }, text)).toBe("34 Main St");
        expect((): string => resolveTextRef({ source: TextSource.SECRET, name: "pin" }, text)).toThrow(/secret pin/);
    });

    it("lists the secrets a recording needs that the run lacks", (): void => {
        const recording: Recording = {
            promptHash: "h",
            recordedAt: "",
            engine: "e",
            elapsedMs: 0,
            steps: [
                { operation: Operation.TYPE_TEXT, text: { source: TextSource.SECRET, name: "password" } },
                { operation: Operation.TYPE_TEXT, text: { source: TextSource.SECRET, name: "pin" } },
            ],
        };
        expect(missingSecrets(recording, { password: "x" })).toEqual(["pin"]);
        // A name that is also a built-in object property is not "given" by the object's prototype.
        const builtIn: Recording = { ...recording, steps: [{ operation: Operation.TYPE_TEXT, text: { source: TextSource.SECRET, name: "constructor" } }] };
        expect(missingSecrets(builtIn, {})).toEqual(["constructor"]);
    });

    it("diverges, rather than crashing, at a step whose text this run cannot supply", async (): Promise<void> => {
        const pin: ReturnType<typeof control> = control(1, "textbox", "PIN", [ControlOperation.FILL]);
        const client: SiteClient = new SiteClient({ start: { controls: [pin] } }, "start");
        const recording: Recording = {
            promptHash: "h",
            recordedAt: "",
            engine: "e",
            elapsedMs: 0,
            steps: [{ operation: Operation.TYPE_TEXT, target: describeTarget(pin, snapshot(1, [pin])), text: { source: TextSource.SECRET, name: "pin" } }],
        };
        const replay: ReplayResult = await new Replayer({ client, limits: { maxControls: 50, maxTextChars: 1_000 }, text }).run(recording);
        expect(replay.completed).toBe(false);
        expect(replay.divergedAt).toBe(0);
        expect(replay.reason).toMatch(/secret pin/);
        expect(client.acts).toHaveLength(0);
    });

    it("diverges at a step that acts on a control but names none, rather than crashing", async (): Promise<void> => {
        const qty: ReturnType<typeof control> = control(1, "combobox", "Qty", [ControlOperation.SELECT]);
        const client: SiteClient = new SiteClient({ start: { controls: [qty] } }, "start");
        const recording: Recording = {
            promptHash: "h",
            recordedAt: "",
            engine: "e",
            elapsedMs: 0,
            steps: [{ operation: Operation.SELECT, optionLabel: "2" }],
        };
        const replay: ReplayResult = await new Replayer({ client, limits: { maxControls: 50, maxTextChars: 1_000 }, text }).run(recording);
        expect(replay.completed).toBe(false);
        expect(replay.divergedAt).toBe(0);
        expect(replay.reason).toMatch(/names no control/);
        expect(client.acts).toHaveLength(0);
    });

    it("names DevTools' refusal when a step keeps being refused, and shows it to the healing engine", async (): Promise<void> => {
        const pw: ReturnType<typeof control> = control(1, "textbox", "Password", [ControlOperation.FILL], { password: true });
        class RefusingClient extends SiteClient {
            override async act(request: ActRequest): Promise<ActResult> {
                if (request.action === ControlAction.FILL) {
                    this.acts.push(request);
                    return { executed: false, reason: "SECRET_DENIED: the field is not a password input", snapshot: await this.snapshot({ maxControls: 50, maxTextChars: 1_000 }) };
                }
                return super.act(request);
            }
        }
        const client: RefusingClient = new RefusingClient({ start: { controls: [pw] } }, "start");
        const recording: Recording = {
            promptHash: "h",
            recordedAt: "",
            engine: "e",
            elapsedMs: 0,
            steps: [{ operation: Operation.TYPE_TEXT, target: describeTarget(pw, snapshot(1, [pw])), text: { source: TextSource.SECRET, name: "password" } }],
        };
        const events: StepEvent[] = [];
        const replay: ReplayResult = await new Replayer({
            client,
            limits: { maxControls: 50, maxTextChars: 1_000 },
            text,
            settledMs: 50,
            onStep: (e: StepEvent): void => {
                events.push(e);
            },
        }).run(recording);
        expect(replay.completed).toBe(false);
        expect(replay.divergedAt).toBe(0);
        expect(replay.reason).toMatch(/refused: SECRET_DENIED/);
        expect(replay.reason).not.toMatch(/not on/);
        // Recorded once, not once per retry.
        expect(replay.history).toEqual([expect.objectContaining({ operation: Operation.TYPE_TEXT, executed: false, reason: expect.stringMatching(/SECRET_DENIED/) })]);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ mode: StepMode.REPLAY, executed: false, reason: expect.stringMatching(/SECRET_DENIED/) });
        expect(client.acts.length).toBeGreaterThan(1);
        // Shaped as the agent's refusals: what was typed (the secret by name) and, in the journey, why.
        expect(replay.history[0].text).toBe("<secret password>");
        expect(replay.journey.steps).toEqual([expect.objectContaining({ step: 1, operation: Operation.TYPE_TEXT, text: "<secret password>", refused: expect.stringMatching(/SECRET_DENIED/) })]);
    });

    it("describes the acted control off the masked page: a secret shown beside it never leaves as its target", async (): Promise<void> => {
        // A demo login page shows the password next to the field; the recording (made by the agent
        // off the masked page) carries the masked context, and so must everything this run says.
        const pw: ReturnType<typeof control> = control(1, "textbox", "Password", [ControlOperation.FILL], { password: true, context: "use pw2 to sign in" });
        const client: SiteClient = new SiteClient({ start: { controls: [pw] } }, "start");
        const masked: ControlSnapshot = maskSecrets(snapshot(1, [pw]), text.secrets);
        const recording: Recording = {
            promptHash: "h",
            recordedAt: "",
            engine: "e",
            elapsedMs: 0,
            steps: [{ operation: Operation.TYPE_TEXT, target: describeTarget(masked.controls[0], masked), text: { source: TextSource.SECRET, name: "password" } }],
        };
        const events: StepEvent[] = [];
        const replay: ReplayResult = await new Replayer({
            client,
            limits: { maxControls: 50, maxTextChars: 1_000 },
            text,
            onStep: (e: StepEvent): void => {
                events.push(e);
            },
        }).run(recording);
        expect(replay.completed).toBe(true);
        // The act itself typed the value.
        expect(client.typed.Password).toBe("pw2");
        const targets: Array<string | undefined> = [replay.history[0].target, events[0].target, replay.journey.steps[0].target];
        for (const target of targets) {
            expect(target).toContain("[secret:password]");
            expect(target).not.toContain("pw2");
        }
        expect(JSON.stringify(replay.history)).not.toContain("pw2");
        expect(JSON.stringify(replay.journey)).not.toContain("pw2");
    });

    it("shapes a refused key press like an executed one: the key travels as `key`, and as the history's text", async (): Promise<void> => {
        class RefusingClient extends SiteClient {
            override async act(request: ActRequest): Promise<ActResult> {
                if (request.action === ControlAction.PRESS_KEY) {
                    this.acts.push(request);
                    return { executed: false, reason: "a dialog opened before the action reached the page", snapshot: await this.snapshot({ maxControls: 50, maxTextChars: 1_000 }) };
                }
                return super.act(request);
            }
        }
        const client: RefusingClient = new RefusingClient({ start: { controls: [] } }, "start");
        const recording: Recording = {
            promptHash: "h",
            recordedAt: "",
            engine: "e",
            elapsedMs: 0,
            steps: [{ operation: Operation.PRESS_KEY, key: "Escape" }],
        };
        const events: StepEvent[] = [];
        const replay: ReplayResult = await new Replayer({
            client,
            limits: { maxControls: 50, maxTextChars: 1_000 },
            text,
            settledMs: 50,
            onStep: (e: StepEvent): void => {
                events.push(e);
            },
        }).run(recording);
        expect(replay.completed).toBe(false);
        expect(replay.reason).toMatch(/PRESS_KEY.*refused: a dialog opened/);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ operation: Operation.PRESS_KEY, key: "Escape", executed: false });
        expect(events[0].text).toBeUndefined();
        expect(replay.history).toEqual([expect.objectContaining({ operation: Operation.PRESS_KEY, text: "Escape", executed: false })]);
    });
});

describe("what a replay observes", (): void => {
    const limits: { maxControls: number; maxTextChars: number } = { maxControls: 50, maxTextChars: 1_000 };
    const secretText: TextStrategy = {
        choices: buildTextChoices("g", [new SuppliedValuesSource({}, { key: "p@ss" })], false, { key: "p@ss" }),
        secrets: { key: "p@ss" },
    };
    const plainText: TextStrategy = { choices: [], secrets: {} };

    it("masks a typed secret's encoded form in the next page's URL, the journey and the final page", async (): Promise<void> => {
        // A GET form: the typed secret becomes a query parameter of the next page — encoded, as a browser submits it.
        const field: ReturnType<typeof control> = control(1, "textbox", "Key", [ControlOperation.FILL]);
        const go: ReturnType<typeof control> = control(2, "button", "Go", [ControlOperation.CLICK]);
        const client: SiteClient = new SiteClient(
            {
                start: { controls: [field, go], links: { Go: "search?key=p%40ss" } },
                "search?key=p%40ss": { controls: [], text: "results for the key" },
            },
            "start"
        );
        const first: ControlSnapshot = snapshot(1, [field, go]);
        const recording: Recording = {
            promptHash: "h",
            recordedAt: "",
            engine: "e",
            elapsedMs: 0,
            steps: [
                { operation: Operation.TYPE_TEXT, target: describeTarget(field, first), text: { source: TextSource.SECRET, name: "key" } },
                { operation: Operation.CLICK, target: describeTarget(go, first) },
            ],
        };
        const events: StepEvent[] = [];
        const replay: ReplayResult = await new Replayer({
            client,
            limits,
            text: secretText,
            settledMs: 50,
            onStep: (e: StepEvent): void => {
                events.push(e);
            },
        }).run(recording);
        expect(replay.completed).toBe(true);
        expect(client.typed.Key).toBe("p@ss");
        // A step's url is the page it acted on; the page it led to is the journey's and the final one.
        expect(replay.snapshot.url).toBe("https://site.test/search?key=[secret:key]");
        expect(replay.journey.pages.map((p): string => p.url)).toContain("https://site.test/search?key=[secret:key]");
        expect(JSON.stringify([events, replay.history, replay.journey, replay.snapshot.url])).not.toMatch(/p@ss|p%40ss/);
    });

    it("sees a page that appears while waiting for a step's target", async (): Promise<void> => {
        // CLICK Checkout shows a loading page; the checkout page (with its total) appears during the
        // wait for "Place order", and must be in the journey the judge reads.
        const checkout: ReturnType<typeof control> = control(1, "button", "Checkout", [ControlOperation.CLICK]);
        const place: ReturnType<typeof control> = control(2, "button", "Place order", [ControlOperation.CLICK]);
        class LoadingClient extends SiteClient {
            override async act(request: ActRequest): Promise<ActResult> {
                if (request.action === ControlAction.WAIT && this.page === "loading") {
                    this.page = "checkout";
                }
                return super.act(request);
            }
        }
        const client: LoadingClient = new LoadingClient(
            {
                start: { controls: [checkout], links: { Checkout: "loading" } },
                loading: { controls: [], text: "Loading…" },
                checkout: { controls: [place], text: "Checkout total 42.00", links: { "Place order": "done" } },
                done: { controls: [], text: "Thank you" },
            },
            "start"
        );
        const recording: Recording = {
            promptHash: "h",
            recordedAt: "",
            engine: "e",
            elapsedMs: 0,
            steps: [
                { operation: Operation.CLICK, target: describeTarget(checkout, snapshot(1, [checkout])) },
                { operation: Operation.CLICK, target: describeTarget(place, snapshot(2, [place])) },
            ],
        };
        const replay: ReplayResult = await new Replayer({ client, limits, text: plainText, settledMs: 50 }).run(recording);
        expect(replay.completed).toBe(true);
        expect(replay.journey.pages.map((p): string => p.url)).toEqual([
            "https://site.test/start",
            "https://site.test/loading",
            "https://site.test/checkout",
            "https://site.test/done",
        ]);
        expect(replay.journey.pages[2].excerpt).toContain("Checkout total 42.00");
    });

    it("keeps the key of an executed key press in the healing engine's history", async (): Promise<void> => {
        const client: SiteClient = new SiteClient({ start: { controls: [] } }, "start");
        const recording: Recording = {
            promptHash: "h",
            recordedAt: "",
            engine: "e",
            elapsedMs: 0,
            steps: [{ operation: Operation.PRESS_KEY, key: "Escape" }],
        };
        const replay: ReplayResult = await new Replayer({ client, limits, text: plainText, settledMs: 50 }).run(recording);
        expect(replay.completed).toBe(true);
        expect(replay.history).toEqual([expect.objectContaining({ operation: Operation.PRESS_KEY, text: "Escape", executed: true })]);
    });

    it("reads progress off what the page says, not the document's identity: a reload of the same page changed nothing", async (): Promise<void> => {
        // DevTools' fingerprint changes on every document (timeOrigin, scroll, form values); the
        // agent measures progress by content, and so does the replay.
        class ReloadingClient extends SiteClient {
            override async act(request: ActRequest): Promise<ActResult> {
                const acted: ActResult = await super.act(request);
                return { ...acted, snapshot: { ...acted.snapshot!, fingerprint: `reload-${acted.snapshot!.snapshotId}` } };
            }
        }
        const button: ControlSnapshot["controls"][number] = control(6, "button", "Sign in", [ControlOperation.CLICK]);
        const client: ReloadingClient = new ReloadingClient({ login: { controls: [button], links: { "Sign in": "login" } } }, "login");
        const start: ControlSnapshot = client.current();
        const recording: Recording = {
            promptHash: "h",
            recordedAt: "",
            engine: "e",
            elapsedMs: 0,
            steps: [{ operation: Operation.CLICK, target: describeTarget(button, start) }],
        };
        const replay: ReplayResult = await new Replayer({ client, limits, text: plainText, settledMs: 50 }).run(recording);
        expect(replay.completed).toBe(true);
        expect(replay.steps[0]).toMatchObject({ operation: Operation.CLICK, executed: true, pageChanged: false });
        expect(replay.history[0]).toMatchObject({ operation: Operation.CLICK, executed: true, pageChanged: false });
    });

    it("names a target-less step once in a divergence", async (): Promise<void> => {
        class RefusingClient extends SiteClient {
            override async act(request: ActRequest): Promise<ActResult> {
                if (request.action === ControlAction.SWITCH_TAB) {
                    this.acts.push(request);
                    return { executed: false, reason: "no tab 2", snapshot: await this.snapshot(limits) };
                }
                return super.act(request);
            }
        }
        const client: RefusingClient = new RefusingClient({ start: { controls: [] } }, "start");
        const recording: Recording = {
            promptHash: "h",
            recordedAt: "",
            engine: "e",
            elapsedMs: 0,
            steps: [{ operation: Operation.SWITCH_TAB, tab: 2 }],
        };
        const replay: ReplayResult = await new Replayer({ client, limits, text: plainText, settledMs: 50 }).run(recording);
        expect(replay.completed).toBe(false);
        expect(replay.reason).toBe("SWITCH_TAB: refused: no tab 2");
    });

    it("acts no more when stopped while a step waits for its target", async (): Promise<void> => {
        // "Place order" appears on the poll after the Stop: the replay must not click it.
        const place: ReturnType<typeof control> = control(2, "button", "Place order", [ControlOperation.CLICK]);
        const abort: AbortController = new AbortController();
        class LateClient extends SiteClient {
            override async act(request: ActRequest): Promise<ActResult> {
                if (request.action === ControlAction.WAIT) {
                    abort.abort();
                    this.page = "checkout";
                }
                return super.act(request);
            }
        }
        const client: LateClient = new LateClient(
            {
                loading: { controls: [], text: "Loading…" },
                checkout: { controls: [place], links: { "Place order": "done" } },
                done: { controls: [], text: "Thank you" },
            },
            "loading"
        );
        const recording: Recording = {
            promptHash: "h",
            recordedAt: "",
            engine: "e",
            elapsedMs: 0,
            steps: [{ operation: Operation.CLICK, target: describeTarget(place, snapshot(1, [place])) }],
        };
        const replay: ReplayResult = await new Replayer({ client, limits, text: plainText, settledMs: 5_000, signal: abort.signal }).run(recording);
        expect(replay.completed).toBe(false);
        expect(replay.reason).toBe("stopped by the caller");
        expect(client.acts.filter((a: ActRequest): boolean => a.action === ControlAction.CLICK)).toHaveLength(0);
        expect(client.page).toBe("checkout");
    });

    it("journals a replayed hand-over as the agent does: its page change when resumed, the pause when stopped", async (): Promise<void> => {
        const recording: Recording = {
            promptHash: "h",
            recordedAt: "",
            engine: "e",
            elapsedMs: 0,
            steps: [
                { operation: Operation.ASK_USER, userAction: UserActionKind.SIGN_IN },
                { operation: Operation.ASK_USER, userAction: UserActionKind.VERIFY },
            ],
        };
        const client: SiteClient = new SiteClient({ login: { controls: [] }, home: { controls: [], text: "Welcome" } }, "login");
        let answers: number = 0;
        const events: StepEvent[] = [];
        const replay: ReplayResult = await new Replayer({
            client,
            limits,
            text: plainText,
            settledMs: 50,
            onStep: (e: StepEvent): void => {
                events.push(e);
            },
            askUser: async (): Promise<boolean> => {
                answers++;
                if (answers === 1) {
                    client.page = "home";
                    return true;
                }
                return false;
            },
        }).run(recording);
        expect(replay.stopped).toBe(true);
        expect(replay.history[0]).toMatchObject({ operation: Operation.ASK_USER, executed: true, pageChanged: true });
        expect(events).toHaveLength(2);
        expect(events[1]).toMatchObject({
            operation: Operation.ASK_USER,
            executed: false,
            reason: "stopped by the user",
            userAction: { kind: UserActionKind.VERIFY },
        });
        expect(events[1].userAction?.waitMs).toBeGreaterThanOrEqual(0);
        expect(replay.steps).toHaveLength(2);
        expect(replay.journey.steps).toHaveLength(2);
    });

    /** A page behind a slow API: a static "Loading…" while a request is in flight until `readyAt`, then the cart. */
    class SlowClient extends SiteClient {
        constructor(private readonly readyAt: () => number) {
            super(
                {
                    loading: { controls: [], text: "Loading…" },
                    cart: { controls: [control(2, "button", "Place order", [ControlOperation.CLICK])], links: { "Place order": "done" } },
                    done: { controls: [], text: "Thank you" },
                },
                "loading"
            );
        }

        override async act(request: ActRequest): Promise<ActResult> {
            if (request.action !== ControlAction.WAIT) {
                return super.act(request);
            }
            await sleep(5);
            const loading: boolean = Date.now() < this.readyAt();
            if (!loading && this.page === "loading") {
                this.page = "cart";
            }
            const acted: ActResult = await super.act(request);
            // A poll that asks about the network hears whether a request is still in flight.
            return request.waitForNetworkMs ? { ...acted, networkIdle: !loading } : acted;
        }
    }

    const placeOrder: Recording = {
        promptHash: "h",
        recordedAt: "",
        engine: "e",
        elapsedMs: 0,
        steps: [{ operation: Operation.CLICK, target: { role: "button", name: "Place order", ordinal: 0 } }],
    };

    it("waits for a target past the settle time while a request is in flight: a static page may still be loading", async (): Promise<void> => {
        const readyAt: number = Date.now() + 300;
        const client: SlowClient = new SlowClient((): number => readyAt);
        const replay: ReplayResult = await new Replayer({ client, limits, text: plainText, settledMs: 50 }).run(placeOrder);
        expect(replay.completed).toBe(true);
        expect(client.page).toBe("done");
        // Every poll asked about the network.
        expect(client.acts.filter((a: ActRequest): boolean => a.action === ControlAction.WAIT).every((a: ActRequest): boolean => (a.waitForNetworkMs ?? 0) > 0)).toBe(true);
    });

    it("gives up at the step's timeout on a page that keeps a request in flight, and says so", async (): Promise<void> => {
        const client: SlowClient = new SlowClient((): number => Number.MAX_SAFE_INTEGER);
        const started: number = Date.now();
        const replay: ReplayResult = await new Replayer({ client, limits, text: plainText, settledMs: 50, stepTimeoutMs: 300 }).run(placeOrder);
        expect(replay.completed).toBe(false);
        expect(Date.now() - started).toBeGreaterThanOrEqual(300);
        expect(replay.reason).toBe('CLICK button "Place order": not on /loading (not found within 300 ms, requests still in flight)');
    });

    it("still gives up once the page has settled with nothing in flight", async (): Promise<void> => {
        const client: SlowClient = new SlowClient((): number => 0);
        client.pages.cart.controls = [];
        const replay: ReplayResult = await new Replayer({ client, limits, text: plainText, settledMs: 50, stepTimeoutMs: 5_000 }).run(placeOrder);
        expect(replay.completed).toBe(false);
        expect(replay.reason).toMatch(/the page settled without it for 50 ms/);
    });
});

describe("ScenarioStore", (): void => {
    let dir: string;
    beforeEach((): void => {
        dir = mkdtempSync(join(tmpdir(), "ibexpress-scenarios-"));
    });
    afterEach((): void => {
        rmSync(dir, { recursive: true, force: true });
    });

    function scenario(name: string): Scenario {
        return {
            formatVersion: SCENARIO_FORMAT_VERSION,
            name,
            goal: "Open the cart",
            url: "https://site.test",
            values: { email: "a@b.c" },
            secretNames: ["password"],
            createdAt: "2026-09-24T00:00:00Z",
            updatedAt: "2026-09-24T00:00:00Z",
        };
    }

    it("saves, lists, reads and deletes", (): void => {
        const store: ScenarioStore = new ScenarioStore(join(dir, "nested"));
        store.save(scenario("cart"));
        store.save(scenario("a-first"));
        expect(store.list().map((s): string => s.name)).toEqual(["a-first", "cart"]);
        expect(store.get("cart").secretNames).toEqual(["password"]);
        expect(store.delete("cart")).toBe(true);
        expect(store.delete("cart")).toBe(false);
        expect((): Scenario => store.get("cart")).toThrow(ScenarioError);
    });

    it("is named by its file: a renamed file is listed, read and deleted by the new name", (): void => {
        const store: ScenarioStore = new ScenarioStore(dir);
        store.save(scenario("cart"));
        renameSync(join(dir, "cart.json"), join(dir, "basket.json"));
        expect(store.list().map((s): string => s.name)).toEqual(["basket"]);
        expect(store.get("basket").name).toBe("basket");
        expect(store.exists("cart")).toBe(false);
        expect(store.delete("basket")).toBe(true);
    });

    it("lists a file by its exact stem: a stray ' shop.json' beside shop.json is not shop twice", (): void => {
        // The stem is tested untrimmed (`validateScenarioName` trims INPUT, a file name is not one):
        // trimming here would read shop.json for the stray file and list the real scenario twice.
        const store: ScenarioStore = new ScenarioStore(dir);
        store.save(scenario("shop"));
        writeFileSync(join(dir, " shop.json"), JSON.stringify(scenario("shop")));
        expect(store.list().map((s): string => s.name)).toEqual(["shop"]);
    });

    it("reports a file whose JSON is not an object as not a scenario", (): void => {
        const store: ScenarioStore = new ScenarioStore(dir);
        writeFileSync(join(dir, "nil.json"), "null");
        writeFileSync(join(dir, "list.json"), "[]");
        expect((): Scenario => store.get("nil")).toThrow(/not a scenario file/);
        expect((): Scenario => store.get("list")).toThrow(ScenarioError);
        expect(store.list()).toEqual([]);
    });

    it("reports a JSON object that is not a scenario (a cache file, a hand-made one) and skips it in the list", (): void => {
        const store: ScenarioStore = new ScenarioStore(dir);
        store.save({ formatVersion: SCENARIO_FORMAT_VERSION, name: "ok", goal: "g", values: {}, secretNames: [], createdAt: "t", updatedAt: "t" });
        writeFileSync(join(dir, "stray.json"), JSON.stringify({ formatVersion: 1, scenario: "shop", entries: [] }));
        writeFileSync(join(dir, "odd.json"), JSON.stringify({ formatVersion: 1, goal: "g", values: [], secretNames: [] }));
        // The natural hand-edit typos: a single name where a list goes, a list where a map goes.
        writeFileSync(join(dir, "pw.json"), JSON.stringify({ formatVersion: 1, goal: "g", values: {}, secretNames: ["password"], passwordSecrets: "password" }));
        writeFileSync(join(dir, "desc.json"), JSON.stringify({ formatVersion: 1, goal: "g", values: {}, secretNames: [], descriptions: ["email"] }));
        // Entries of the wrong type: a committed number where a text goes, a name that is not one.
        writeFileSync(join(dir, "qty.json"), JSON.stringify({ formatVersion: 1, goal: "g", values: { qty: 2 }, secretNames: [] }));
        writeFileSync(join(dir, "dnum.json"), JSON.stringify({ formatVersion: 1, goal: "g", values: {}, secretNames: [], descriptions: { qty: 2 } }));
        writeFileSync(join(dir, "snum.json"), JSON.stringify({ formatVersion: 1, goal: "g", values: {}, secretNames: [1] }));
        writeFileSync(join(dir, "pnum.json"), JSON.stringify({ formatVersion: 1, goal: "g", values: {}, secretNames: [], passwordSecrets: [null] }));
        expect((): Scenario => store.get("stray")).toThrow(/not a scenario file \(no goal\)/);
        expect((): Scenario => store.get("odd")).toThrow(/values is not an object of strings/);
        expect((): Scenario => store.get("pw")).toThrow(/passwordSecrets is not a list of strings/);
        expect((): Scenario => store.get("desc")).toThrow(/descriptions is not an object of strings/);
        expect((): Scenario => store.get("qty")).toThrow(/values is not an object of strings/);
        expect((): Scenario => store.get("dnum")).toThrow(/descriptions is not an object of strings/);
        expect((): Scenario => store.get("snum")).toThrow(/secretNames is not a list of strings/);
        expect((): Scenario => store.get("pnum")).toThrow(/passwordSecrets is not a list of strings/);
        // The single strings too: `scenarios list` reads `.slice` off a description, a run `.trim` off a profile.
        for (const [file, field, value] of [
            ["dint", "description", 1],
            ["uint", "url", 2],
            ["pbool", "profile", true],
            ["tobj", "textModel", {}],
        ] as const) {
            writeFileSync(join(dir, `${file}.json`), JSON.stringify({ formatVersion: 1, goal: "g", values: {}, secretNames: [], [field]: value }));
            expect((): Scenario => store.get(file)).toThrow(new RegExp(`${field} is not a string`));
        }
        // The stealth browser is a yes or no: a "yes" would read as truthy and start the wrong daemon.
        writeFileSync(join(dir, "sstr.json"), JSON.stringify({ formatVersion: 1, goal: "g", values: {}, secretNames: [], stealth: "yes" }));
        expect((): Scenario => store.get("sstr")).toThrow(/stealth is not true or false/);
        // Text candidate kinds: a typo or a bare string would fail the run in the text setup.
        for (const [file, value] of [
            ["tclit", ["literal"]],
            ["tcstr", "quoted"],
        ] as const) {
            writeFileSync(join(dir, `${file}.json`), JSON.stringify({ formatVersion: 1, goal: "g", values: {}, secretNames: [], textCandidates: value }));
            expect((): Scenario => store.get(file)).toThrow(/textCandidates is not a list of text candidate kinds/);
        }
        expect(store.list().map((x: { name: string }): string => x.name)).toEqual(["ok"]);
    });

    it("keys a prompt by its normalised URL, so the CLI and the UI share a recording", (): void => {
        expect(promptHash("Buy", "https://x.test")).toBe(promptHash("Buy", "https://x.test/"));
        expect(promptHash("Buy", "HTTPS://X.test/a")).toBe(promptHash("Buy", "https://x.test/a"));
        expect(promptHash("Buy", "https://x.test/a")).not.toBe(promptHash("Buy", "https://x.test/b"));
        expect(promptHash("Buy", undefined)).toBe(promptHash("Buy", undefined));
    });

    it("refuses bad names and files from a newer version", (): void => {
        expect((): string => validateScenarioName("../etc")).toThrow(/Invalid scenario name/);
        const store: ScenarioStore = new ScenarioStore(dir);
        writeFileSync(join(dir, "future.json"), JSON.stringify({ ...scenario("future"), formatVersion: 99 }));
        expect((): Scenario => store.get("future")).toThrow(/format 99/);
        expect(store.list()).toEqual([]);
    });

    it("keeps the prompt only: a recording in an older file is dropped, and never written", (): void => {
        const store: ScenarioStore = new ScenarioStore(dir);
        const recording: Recording = { promptHash: "h", recordedAt: "t", engine: "jev", steps: [], elapsedMs: 1 };
        writeFileSync(join(dir, "old.json"), JSON.stringify({ ...scenario("old"), recording }));
        expect(store.get("old")).not.toHaveProperty("recording");
        store.save({ ...scenario("new"), recording } as Scenario);
        expect(JSON.parse(readFileSync(join(dir, "new.json"), "utf-8"))).not.toHaveProperty("recording");
    });

    it("hashes the prompt so an edited goal invalidates a recording", (): void => {
        expect(promptHash("Open the cart", "https://a")).toBe(promptHash(" Open the cart ", "https://a"));
        expect(promptHash("Open the cart", "https://a")).not.toBe(promptHash("Open the basket", "https://a"));
    });
});

describe("RecordingCache", (): void => {
    let dir: string;
    beforeEach((): void => {
        dir = mkdtempSync(join(tmpdir(), "ibexpress-cache-"));
    });
    afterEach((): void => {
        rmSync(dir, { recursive: true, force: true });
    });

    const recording: (hash: string, recordedAt?: string) => Recording = (hash: string, recordedAt: string = "2026-09-25T00:00:00Z"): Recording => ({
        promptHash: hash,
        recordedAt,
        engine: "jev",
        steps: [],
        elapsedMs: 1,
    });
    const put: (cache: RecordingCache, hash: string, recordedAt?: string) => boolean = (cache: RecordingCache, hash: string, recordedAt?: string): boolean =>
        cache.put("shop", { promptHash: hash, goal: `goal ${hash}`, url: "https://shop.test", recording: recording(hash, recordedAt) });

    it("keeps one recording per prompt, the latest", (): void => {
        const cache: RecordingCache = new RecordingCache(dir);
        expect(cache.get("shop", "a")).toBeUndefined();
        put(cache, "a", "2026-09-25T01:00:00Z");
        put(cache, "b");
        put(cache, "a", "2026-09-25T02:00:00Z");
        expect(cache.summary("shop")).toEqual({ entries: 2, latestAt: "2026-09-25T02:00:00Z" });
        expect(cache.get("shop", "a")?.recordedAt).toBe("2026-09-25T02:00:00Z");
        expect(cache.peek("shop", "b")?.promptHash).toBe("b");
        expect(cache.get("other", "a")).toBeUndefined();
    });

    it("writes a copied cache file back to itself, never to the scenario it was copied from", (): void => {
        const cache: RecordingCache = new RecordingCache(dir);
        put(cache, "a");
        const original: string = readFileSync(join(dir, "shop.json"), "utf-8");
        copyFileSync(join(dir, "shop.json"), join(dir, "other.json"));
        expect(cache.get("other", "a")).toBeDefined();
        expect(readFileSync(join(dir, "shop.json"), "utf-8")).toBe(original);
        expect(JSON.parse(readFileSync(join(dir, "other.json"), "utf-8")).scenario).toBe("other");
        expect(cache.scenarios()).toEqual(["other", "shop"]);
    });

    it("holds at most its limit per scenario, dropping the one used longest ago", async (): Promise<void> => {
        const cache: RecordingCache = new RecordingCache(dir, 2);
        put(cache, "a");
        await new Promise((r: (v: unknown) => void): unknown => setTimeout(r, 5));
        put(cache, "b");
        await new Promise((r: (v: unknown) => void): unknown => setTimeout(r, 5));
        // Replaying "a" makes it the recently used one: "b" goes when "c" comes.
        expect(cache.get("shop", "a")).toBeDefined();
        await new Promise((r: (v: unknown) => void): unknown => setTimeout(r, 5));
        put(cache, "c");
        expect(cache.peek("shop", "a")).toBeDefined();
        expect(cache.peek("shop", "b")).toBeUndefined();
        expect(cache.peek("shop", "c")).toBeDefined();
        expect(cache.summary("shop").entries).toBe(2);
    });

    it("keeps the recording that just passed, whatever use times the older entries carry", (): void => {
        const cache: RecordingCache = new RecordingCache(dir, 1);
        put(cache, "a");
        // A copied cache file from a clock that runs ahead.
        const file: string = join(dir, "shop.json");
        const copied: { entries: Array<{ lastUsedAt: string }> } = JSON.parse(readFileSync(file, "utf-8"));
        copied.entries[0].lastUsedAt = "2030-01-01T00:00:00.000Z";
        writeFileSync(file, JSON.stringify(copied));
        expect(put(cache, "b")).toBe(true);
        expect(cache.peek("shop", "b")).toBeDefined();
        expect(cache.peek("shop", "a")).toBeUndefined();
    });

    it("lists only scenarios, so clearing every cache skips a stray file", (): void => {
        const cache: RecordingCache = new RecordingCache(dir);
        put(cache, "a");
        writeFileSync(join(dir, "my shop.json"), "{}");
        // A leading space is a different stem, not shop's cache (the name test does not trim).
        writeFileSync(join(dir, " shop.json"), "{}");
        expect(cache.scenarios()).toEqual(["shop"]);
        expect((): void => {
            for (const name of cache.scenarios()) {
                cache.clear(name);
            }
        }).not.toThrow();
        expect(cache.scenarios()).toEqual([]);
    });

    it("clears a scenario's recordings, lists the cached scenarios, and reads a broken file as empty", (): void => {
        const cache: RecordingCache = new RecordingCache(dir);
        put(cache, "a");
        expect(cache.scenarios()).toEqual(["shop"]);
        expect(cache.clear("shop")).toBe(true);
        expect(cache.clear("shop")).toBe(false);
        expect(cache.summary("shop")).toEqual({ entries: 0 });
        writeFileSync(join(dir, "shop.json"), "{ not json");
        expect(cache.get("shop", "a")).toBeUndefined();
        put(cache, "a");
        expect(cache.peek("shop", "a")).toBeDefined();
    });

    it("drops entries that are not replayable recordings, and does not throw on them", (): void => {
        const cache: RecordingCache = new RecordingCache(dir);
        put(cache, "a");
        const file: string = join(dir, "shop.json");
        const parsed: { entries: unknown[] } = JSON.parse(readFileSync(file, "utf-8"));
        parsed.entries.push(
            null,
            { promptHash: "b", goal: "g", lastUsedAt: "2026-09-25T00:00:00Z" },
            { promptHash: "c", recording: recording("c") },
            // A recording with a step that is not one: dropped, not a crash at the run's start.
            { promptHash: "d", goal: "g", lastUsedAt: "2026-09-25T00:00:00Z", recording: { ...recording("d"), steps: [null] } },
            // Operations a replay cannot carry out (never recorded, or mis-cased): dropped too.
            { promptHash: "e", goal: "g", lastUsedAt: "2026-09-25T00:00:00Z", recording: { ...recording("e"), steps: [{ operation: "WAIT" }] } },
            { promptHash: "f", goal: "g", lastUsedAt: "2026-09-25T00:00:00Z", recording: { ...recording("f"), steps: [{ operation: "click" }] } },
            // A step that acts on a control but names none: nothing to act on, dropped.
            { promptHash: "g", goal: "g", lastUsedAt: "2026-09-25T00:00:00Z", recording: { ...recording("g"), steps: [{ operation: "SELECT", optionLabel: "2" }] } },
            // A target `findTarget` cannot read (`context` must be a string): dropped too.
            {
                promptHash: "h",
                goal: "g",
                lastUsedAt: "2026-09-25T00:00:00Z",
                recording: { ...recording("h"), steps: [{ operation: "CLICK", target: { role: "button", name: "Add", context: 5, ordinal: 0 } }] },
            }
        );
        writeFileSync(file, JSON.stringify(parsed));
        expect(cache.summary("shop")).toEqual({ entries: 1, latestAt: "2026-09-25T00:00:00Z" });
        expect(cache.peek("shop", "b")).toBeUndefined();
        expect(cache.peek("shop", "c")).toBeUndefined();
        expect(cache.peek("shop", "d")).toBeUndefined();
        expect(cache.peek("shop", "e")).toBeUndefined();
        expect(cache.peek("shop", "f")).toBeUndefined();
        expect(cache.peek("shop", "g")).toBeUndefined();
        expect(cache.peek("shop", "h")).toBeUndefined();
        expect(cache.get("shop", "a")?.promptHash).toBe("a");
        expect(JSON.parse(readFileSync(file, "utf-8")).entries).toHaveLength(1);
    });

    it("reports a directory it cannot write instead of throwing, when given somewhere to report it", (): void => {
        const warnings: string[] = [];
        const blocked: string = join(dir, "not-a-dir");
        writeFileSync(blocked, "a file where the cache directory should be");
        const cache: RecordingCache = new RecordingCache(blocked, 5, (m: string): void => {
            warnings.push(m);
        });
        expect(put(cache, "a")).toBe(false);
        expect(cache.put("shop", { promptHash: "a", goal: "g", recording: recording("a") })).toBe(false);
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toMatch(/recording cache .*shop\.json could not be written/);
        // The CLI's cache, with no run to warn, still fails loudly.
        expect((): boolean => new RecordingCache(blocked).put("shop", { promptHash: "a", goal: "g", recording: recording("a") })).toThrow();
    });

    it("hands a recording it read to the run even when it cannot mark it used", (): void => {
        const warnings: string[] = [];
        const cache: RecordingCache = new RecordingCache(dir, 5, (m: string): void => {
            warnings.push(m);
        });
        put(cache, "a");
        chmodSync(dir, 0o500);
        try {
            expect(cache.get("shop", "a")?.promptHash).toBe("a");
            expect(warnings).toEqual([expect.stringMatching(/could not be written/)]);
        } finally {
            chmodSync(dir, 0o700);
        }
    });
});

describe("recordedTabIndex", (): void => {
    it("finds the recorded tab by its address after the indexes shifted, else by index", (): void => {
        const page = {
            tabs: [
                { index: 0, url: "https://shop.test/orders?x=1", title: "Orders", active: false },
                { index: 1, url: "https://shop.test/invoice/7", title: "Invoice", active: true },
            ],
        } as never;
        expect(recordedTabIndex({ operation: "SWITCH_TAB", tab: 2, tabUrl: "https://shop.test/orders" } as never, page)).toBe(0);
        expect(recordedTabIndex({ operation: "SWITCH_TAB", tab: 1, tabUrl: "https://elsewhere.test/" } as never, page)).toBe(1);
        expect(recordedTabIndex({ operation: "SWITCH_TAB", tab: 0 } as never, page)).toBe(0);
        // A recorded address is masked: the live one is compared masked too.
        expect(recordedTabIndex({ operation: "SWITCH_TAB", tab: 0, tabUrl: "https://shop.test/invoice/[secret:inv]" } as never, page, { inv: "7" })).toBe(1);
    });
});
