import { Agent, RunResult, RunStatus } from "../../../src/agent/agent";
import { buildFieldTextRequest, FIELD_TEXT_HEAD, FieldTextChoice, Operation } from "../../../src/agent/policy";
import { ActResult, Control, ControlOperation } from "../../../src/devtools/types";
import { recordSteps } from "../../../src/scenario/recording";
import { resolveTextRef } from "../../../src/scenario/replayer";
import { buildTextChoices, SuppliedValuesSource } from "../../../src/text/candidates";
import { TextSource, TextStrategy } from "../../../src/text/types";
import { FakeClient } from "../../helpers/fake-client";
import { control, snapshot } from "../../helpers/fixtures";
import { named, ScriptedDecider } from "../../helpers/scripted-decider";

function textStrategy(values: Record<string, string> = {}, secrets: Record<string, string> = {}): TextStrategy {
    return {
        choices: buildTextChoices("goal", [new SuppliedValuesSource(values, secrets)], false, secrets),
        secrets,
    };
}

const VALUES: Record<string, string> = { street: "Main St 1", city: "Springfield", zip: "12345" };

/** The address field holding `value`, as the page shows it after a fill. */
function address(value: string, extra: Partial<Control> = {}): Control {
    return control(1, "textbox", "Delivery address", [ControlOperation.FILL], { value, ...extra });
}

/** A page whose address field holds what the act typed (as a real fill leaves it). */
function typingClient(first: Control = address("")): FakeClient {
    let n: number = 1;
    const act: (request: { value?: string }) => ActResult = (request: { value?: string }): ActResult => {
        n++;
        return { executed: true, snapshot: snapshot(n, [address(request.value ?? "")], { fingerprint: `fp-${n}` }) };
    };
    return new FakeClient(snapshot(1, [first]), [act, act, act, act]);
}

type Asked = Array<{ field: string; options: Record<string, string> }>;

function withFieldText(decider: ScriptedDecider, choices: FieldTextChoice[]): Asked {
    const asked: Asked = [];
    (decider as unknown as { chooseFieldText: unknown }).chooseFieldText = async (
        _input: unknown,
        field: Control,
        options: Record<string, string>
    ): Promise<{ choice: FieldTextChoice; probabilities: Record<string, number> }> => {
        asked.push({ field: field.name, options });
        const choice: FieldTextChoice = choices[asked.length - 1];
        return { choice, probabilities: { [choice]: 0.9 } };
    };
    return asked;
}

function typeInto(textKey: string): { operation: Operation; target: (c: Control) => boolean; textKey: string } {
    return { operation: Operation.TYPE_TEXT, target: named("Delivery address"), textKey };
}

describe("Agent: a second text for a field that holds the run's first", (): void => {
    it("types the two joined when the engine picks a join, and the recording replays it by its parts", async (): Promise<void> => {
        const client: FakeClient = typingClient();
        const decider: ScriptedDecider = new ScriptedDecider([
            typeInto("value:street"),
            typeInto("value:city"),
            typeInto("value:zip"),
            { operation: Operation.DONE },
        ]);
        const asked: Asked = withFieldText(decider, [FieldTextChoice.JOIN_COMMA, FieldTextChoice.JOIN_SPACE]);
        const text: TextStrategy = textStrategy(VALUES);
        const result: RunResult = await new Agent({ client, decider, goal: "Ship to Main St 1, Springfield 12345", text }).run();

        expect(result.status).toBe(RunStatus.DONE);
        expect(client.acts.map((a) => a.value)).toEqual(["Main St 1", "Main St 1, Springfield", "Main St 1, Springfield 12345"]);
        // Asked for the second and third texts only; each option names the text the field would hold.
        expect(asked.map((a) => a.field)).toEqual(["Delivery address", "Delivery address"]);
        expect(asked[0].options).toEqual({
            [FieldTextChoice.REPLACE]: 'the field holds only "Springfield"; "Main St 1" is removed',
            [FieldTextChoice.JOIN_COMMA]: 'the field holds "Main St 1, Springfield"',
            [FieldTextChoice.JOIN_SPACE]: 'the field holds "Main St 1 Springfield"',
        });
        expect(result.steps[2]).toMatchObject({ text: "Main St 1, Springfield 12345", textSource: TextSource.COMBINED });

        // The recording keeps the last fill of the field, by its parts: values by name, resolved again.
        const recorded = recordSteps(result.steps);
        expect(recorded).toHaveLength(1);
        expect(resolveTextRef(recorded[0].text!, text)).toBe("Main St 1, Springfield 12345");
        const moved: TextStrategy = textStrategy({ ...VALUES, city: "Shelbyville" });
        expect(resolveTextRef(recorded[0].text!, moved)).toBe("Main St 1, Shelbyville 12345");
    });

    it("types the new text alone when the engine picks REPLACE", async (): Promise<void> => {
        const client: FakeClient = typingClient();
        const decider: ScriptedDecider = new ScriptedDecider([typeInto("value:street"), typeInto("value:city"), { operation: Operation.DONE }]);
        withFieldText(decider, [FieldTextChoice.REPLACE]);
        const result: RunResult = await new Agent({ client, decider, goal: "x", text: textStrategy(VALUES) }).run();
        expect(client.acts.map((a) => a.value)).toEqual(["Main St 1", "Springfield"]);
        expect(result.steps[1].textSource).toBe(TextSource.VALUE);
    });

    it("does not ask when the page no longer shows the run's text in the field", async (): Promise<void> => {
        // The page clears the field after the first fill (a search box after its search).
        const cleared: () => ActResult = (): ActResult => ({ executed: true, snapshot: snapshot(2, [address("")], { fingerprint: "fp-2" }) });
        const client: FakeClient = new FakeClient(snapshot(1, [address("")]), [cleared, cleared]);
        const decider: ScriptedDecider = new ScriptedDecider([typeInto("value:street"), typeInto("value:city"), { operation: Operation.DONE }]);
        const asked: Asked = withFieldText(decider, [FieldTextChoice.JOIN_COMMA]);
        await new Agent({ client, decider, goal: "x", text: textStrategy(VALUES) }).run();
        expect(asked).toEqual([]);
        expect(client.acts.map((a) => a.value)).toEqual(["Main St 1", "Springfield"]);
    });

    it("does not ask about text the page put in the field, the same text again, or a new text that keeps the old", async (): Promise<void> => {
        // Prefilled by the page, not typed by the run: a plain replace.
        const client: FakeClient = typingClient(address("Old Road 9"));
        const decider: ScriptedDecider = new ScriptedDecider([
            typeInto("value:street"),
            typeInto("value:street"),
            typeInto("value:full"),
            { operation: Operation.DONE },
        ]);
        const asked: Asked = withFieldText(decider, [FieldTextChoice.JOIN_COMMA]);
        await new Agent({ client, decider, goal: "x", text: textStrategy({ ...VALUES, full: "Main St 1, Springfield" }) }).run();
        expect(asked).toEqual([]);
        expect(client.acts.map((a) => a.value)).toEqual(["Main St 1", "Main St 1", "Main St 1, Springfield"]);
    });

    it("never joins a secret", async (): Promise<void> => {
        const client: FakeClient = typingClient();
        const decider: ScriptedDecider = new ScriptedDecider([typeInto("value:street"), typeInto("secret:token"), typeInto("value:city"), { operation: Operation.DONE }]);
        const asked: Asked = withFieldText(decider, [FieldTextChoice.JOIN_COMMA]);
        await new Agent({ client, decider, goal: "x", text: textStrategy(VALUES, { token: "s3cr3t-token" }) }).run();
        // Neither the secret over a value nor a value over the secret is asked about.
        expect(asked).toEqual([]);
        expect(client.acts.map((a) => a.value)).toEqual(["Main St 1", "s3cr3t-token", "Springfield"]);
    });
});

describe("buildFieldTextRequest", (): void => {
    it("asks one choice question naming the field, with the resulting texts as the options", (): void => {
        const field: Control = address("Main St 1");
        const request = buildFieldTextRequest(
            { goal: "Ship it", snapshot: snapshot(1, [field]), history: [], textChoices: [] },
            field,
            { [FieldTextChoice.REPLACE]: "a", [FieldTextChoice.JOIN_COMMA]: "b", [FieldTextChoice.JOIN_SPACE]: "c" },
            { maxOptions: 50, maxTextChars: 1000, maxLabelChars: 100, maxStateElements: 50, compact: false }
        );
        const question = request.questions[FIELD_TEXT_HEAD];
        expect(question.criteria).toEqual({ REPLACE: "a", JOIN_COMMA: "b", JOIN_SPACE: "c" });
        expect(JSON.stringify(question.instructions)).toContain('\\"Delivery address\\"');
    });
});
