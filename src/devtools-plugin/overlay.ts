/**
 * The marks the control tools draw on the page they act on, the same ones
 * IronBee DevTools draws for its own interaction tools (copied from its
 * highlight-overlay.ts; page-side drawing only): a ripple at the click point
 * and a short-lived box around the element acted on.
 *
 * These are drawn by the platform itself, not requested per call — a recording
 * shows what happened without anyone having to ask for it.
 *
 * Rendered into a shadow root so page CSS cannot reach it, and with
 * `pointer-events: none` so it never intercepts real input.
 *
 * Installed into the frame that OWNS the element rather than the top frame:
 * `getBoundingClientRect()` is frame-local and a `position: fixed` overlay inside
 * an iframe is laid out against that iframe's viewport, so an element inside an
 * iframe is marked correctly with no coordinate translation.
 *
 * Every mark removes itself when its animation ends, so there is nothing to clear
 * and nothing to track between calls.
 */

import type { ElementHandle } from "playwright-core";

/** Id of the overlay host element. */
export const OVERLAY_HOST_ID: string = "__ironbee_devtools_overlay__";

/** Default mark colour (deep pink). */
export const DEFAULT_HIGHLIGHT_COLOR: string = "#FF1493";
/** How far outside the element's bounds a box is drawn, px. */
export const DEFAULT_HIGHLIGHT_PADDING: number = 8;
/** Box border thickness, px. */
export const DEFAULT_HIGHLIGHT_BORDER_WIDTH: number = 3;
/** How long a click ripple runs, ms. */
export const DEFAULT_CLICK_RIPPLE_DURATION_MS: number = 700;
/** How long an action box stays up before fading out, ms. */
export const DEFAULT_ACTION_BOX_DURATION_MS: number = 900;

export interface ClickRippleOptions {
    color: string;
    durationMs: number;
    /** Viewport point to centre on (where the click goes); the element's centre otherwise. */
    at?: { x: number; y: number };
}

/**
 * A box around the element an interaction is acting on. Deliberately short-lived:
 * a flow of twenty steps would be unreadable if every action left a box behind.
 */
export interface ActionBoxOptions {
    color: string;
    padding: number;
    borderWidth: number;
    durationMs: number;
}

interface RippleCommand extends ClickRippleOptions {
    kind: "ripple";
}

interface ActionCommand extends ActionBoxOptions {
    kind: "action";
}

type OverlayCommand = RippleCommand | ActionCommand;

const OVERLAY_CSS: string = `
.ib-action-box {
  position: fixed; box-sizing: border-box;
  border-style: solid; border-radius: 0;
  animation: ib-action-out var(--ib-dur) ease-out forwards;
}
@keyframes ib-action-out {
  0%   { opacity: 0; }
  8%   { opacity: 1; }
  65%  { opacity: 1; }
  100% { opacity: 0; }
}
.ib-ripple {
  position: fixed; box-sizing: border-box;
  border-radius: 50%; border-style: solid; border-width: 4px;
  transform: translate(-50%, -50%);
  animation: ib-ripple-out var(--ib-dur) ease-out forwards;
}
@keyframes ib-ripple-out {
  0%   { transform: translate(-50%, -50%) scale(0.2); opacity: 1; }
  100% { transform: translate(-50%, -50%) scale(1.1); opacity: 0; }
}
`;

/**
 * Runs in the page. Installs the overlay if missing, then draws one mark on `el`.
 *
 * Self-contained on purpose — it is serialized into the frame, so it must not
 * reference anything from module scope except its own arguments. Note also that
 * it declares no named function expressions: esbuild's keepNames (on in
 * `scripts/build.js` for `dist/`) rewrites `const fn = () => {}` to
 * `__name(fn, "fn")`, and that helper does not exist in the page.
 * scripts/build-devtools-plugin.js sets keepNames: false for the same reason.
 */
 
const overlayPageFunction: (el: SVGElement | HTMLElement, args: { hostId: string; command: any; css: string }) => void = (
    el: SVGElement | HTMLElement,
    args: { hostId: string; command: any; css: string }
): void => {
    const doc: Document = el.ownerDocument;
    let host: HTMLElement | null = doc.getElementById(args.hostId);

    if (!host) {
        host = doc.createElement("div");
        host.id = args.hostId;
        host.style.cssText =
            "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
        doc.documentElement.appendChild(host);
        const shadowRoot: ShadowRoot = host.attachShadow({ mode: "open" });
        const style: HTMLStyleElement = doc.createElement("style");
        style.textContent = args.css;
        shadowRoot.appendChild(style);
    }

    const shadow: ShadowRoot = host.shadowRoot as ShadowRoot;
    const command: any = args.command;
    const rect: DOMRect = el.getBoundingClientRect();
    const mark: HTMLElement = doc.createElement("div");

    if (command.kind === "ripple") {
        const size: number = Math.min(
            Math.max(Math.max(rect.width, rect.height) * 0.9, 28),
            90
        );
        const cx: number = command.at ? command.at.x : rect.x + rect.width / 2;
        const cy: number = command.at ? command.at.y : rect.y + rect.height / 2;
        mark.className = "ib-ripple";
        mark.style.cssText =
            `left:${cx}px;top:${cy}px;` +
            `width:${size}px;height:${size}px;border-color:${command.color};` +
            `--ib-dur:${command.durationMs}ms`;
        // The second assignment is dropped by engines without color-mix, leaving
        // the mark unfilled rather than opaque.
        mark.style.background = "transparent";
        mark.style.background = `color-mix(in srgb, ${command.color} 22%, transparent)`;
    } else {
        const pad: number = command.padding;
        mark.className = "ib-action-box";
        mark.style.cssText =
            `left:${rect.x - pad}px;top:${rect.y - pad}px;` +
            `width:${rect.width + pad * 2}px;height:${rect.height + pad * 2}px;` +
            `border:${command.borderWidth}px solid ${command.color};` +
            `--ib-dur:${command.durationMs}ms`;
        mark.style.background = "transparent";
        mark.style.background = `color-mix(in srgb, ${command.color} 8%, transparent)`;
    }

    shadow.appendChild(mark);
    setTimeout((): void => mark.remove(), command.durationMs + 80);
};
 

/** A handle on the element already resolved (the control tools act on the observed element itself). */
export type MarkTarget = ElementHandle<Element>;

async function apply(
    target: MarkTarget,
    command: OverlayCommand
): Promise<void> {
    await target.evaluate(overlayPageFunction, {
        hostId: OVERLAY_HOST_ID,
        command,
        css: OVERLAY_CSS,
    });
}

/** Draws a one-shot ripple centred on `at`, or on the element. */
export async function drawClickRipple(
    target: MarkTarget,
    options: ClickRippleOptions
): Promise<void> {
    await apply(target, { kind: "ripple", ...options });
}

/** Draws a short-lived box around the element. */
export async function drawActionBox(
    target: MarkTarget,
    options: ActionBoxOptions
): Promise<void> {
    await apply(target, { kind: "action", ...options });
}

/**
 * Whether an interaction tool should mark what it is acting on.
 *
 * Precedence: the call's own `animate`, then the configured override, then
 * whether a screen recording is running — so a recording shows what happened
 * without anyone asking, while plain runs keep their existing output.
 *
 * Takes the recording check structurally rather than importing the session
 * context, which would point this module back at its own consumers.
 */
export function shouldMarkAction(
    session: { isRecording(): boolean },
    animate: boolean | undefined,
    configured: boolean | undefined
): boolean {
    return animate ?? configured ?? session.isRecording();
}
