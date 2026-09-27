import { Control, ControlOperation, ControlSnapshot } from "../../src/devtools/types";
import { EngineProfile } from "../../src/engine/types";

export function control(
    id: number,
    role: string,
    name: string,
    ops: ControlOperation[],
    extra: Partial<Control> = {}
): Control {
    return { id, role, name, ops, ...extra };
}

export function snapshot(snapshotId: number, controls: Control[], extra: Partial<ControlSnapshot> = {}): ControlSnapshot {
    return {
        snapshotId,
        url: "https://shop.test/login",
        title: "Shop",
        text: "Login Email Password",
        controls,
        omittedControls: 0,
        offscreenControls: 0,
        canScrollUp: false,
        canScrollDown: false,
        fingerprint: `fp-${snapshotId}`,
        ...extra,
    };
}

export const LOGIN_CONTROLS: Control[] = [
    control(4, "textbox", "Email", [ControlOperation.FILL, ControlOperation.CLICK], { value: "" }),
    control(5, "textbox", "Password", [ControlOperation.FILL, ControlOperation.CLICK], {
        password: true,
        filled: true,
    }),
    control(6, "button", "Login", [ControlOperation.CLICK]),
    control(9, "combobox", "Country", [ControlOperation.SELECT], {
        value: "Turkey",
        options: [
            { value: "de", label: "Germany" },
            { value: "uk", label: "United Kingdom" },
        ],
    }),
];

/** Many identical "Add to cart" buttons, one per product. */
export function productControls(count: number): Control[] {
    const out: Control[] = [control(2, "button", "Products", [ControlOperation.CLICK])];
    for (let i: number = 0; i < count; i++) {
        out.push(
            control(100 + i, "button", "Add to cart", [ControlOperation.CLICK], {
                context: i === count - 1 ? "Sony WH-1000XM5 headphones" : `Product ${i} gadget`,
            })
        );
    }
    out.push(control(8, "button", "Cart", [ControlOperation.CLICK]));
    return out;
}

export interface ChoiceAnswerShape {
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
}

/** A well-formed choice answer putting `p` on `choice`, the rest spread evenly. */
export function answer(choice: string, options: string[], p: number = 0.9): ChoiceAnswerShape {
    const rest: number = options.length > 1 ? (1 - p) / (options.length - 1) : 0;
    const probabilities: Record<string, number> = {};
    for (const o of options) {
        probabilities[o] = o === choice ? (options.length > 1 ? p : 1) : rest;
    }
    return { choice, probabilities, confidence: p };
}

/** A small-context engine's profile: short instructions, few options, clipped state. */
export const COMPACT_PROFILE: EngineProfile = {
    maxOptions: 20,
    maxTextChars: 900,
    maxLabelChars: 60,
    maxStateElements: 0,
    compact: true,
};
