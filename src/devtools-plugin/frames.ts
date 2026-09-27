import type { RuntimeRequest, RuntimeSnapshot } from "./runtime";

import type { ElementHandle, Frame, Page } from "playwright-core";

/**
 * Controls inside iframes (BROWSER_CONTROL_SNAPSHOT_FRAMES): an embedded
 * payment form, a login widget. The same page-side runtime runs in each frame
 * — `frame.evaluate` reaches a cross-origin frame too — and the Node side
 * merges what they saw:
 *
 * - **Ids.** A frame control's id is `FRAME_ID_BASE + slot * FRAME_ID_STRIDE
 *   + its runtime id`, and the snapshot keeps an explicit map from those ids
 *   to (frame, runtime id). Nothing is derived from an id's value: a page
 *   control is simply one that is not in the map, so the page's own ids mean
 *   exactly what they mean without frames, however large they grow.
 * - **Routing.** The map is the snapshot's own (StoredControlSnapshot): an
 *   action resolves its control once, against the snapshot it was decided on,
 *   never against a later one.
 * - **Coordinates.** The runtime answers in its frame's viewport; the point is
 *   mapped onto the page through the FRAME element's box on the page
 *   (Playwright's boundingBox — borders, padding, transforms and zoom
 *   included), and used only when the page itself shows the frame there.
 * - **Scope.** The main document's own frames (one level), visible and larger
 *   than a tracking pixel, the first {@link MAX_FRAMES} of them in the order
 *   they attached (Playwright's child-frame order). A frame inside a frame is not read. Every frame read is bounded in
 *   time: a slow or hung frame is skipped, never waited on.
 */

/**
 * `text` cut to at most `max` characters, ending in "…" when it was cut — as the runtime's
 * `clip` does, so a value shown on the page that straddles the cut is still recognised (and
 * masked) as a value cut short. Here (not in snapshot.ts) so the frame label can use it too.
 */
export function cutText(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    return max <= 0 ? "" : `${text.slice(0, max - 1)}…`;
}

export const FRAME_ID_BASE: number = 1_000_000_000;
export const FRAME_ID_STRIDE: number = 1_000_000;
/** Frames read per snapshot (the visible ones, in the order they attached). */
export const MAX_FRAMES: number = 8;
/** Frames looked at to find those — hidden ad / analytics frames often come first. */
const MAX_FRAMES_MEASURED: number = 32;
/** A frame smaller than this on either side is skipped (pixels, hidden widgets). */
const MIN_FRAME_SIDE: number = 20;
/** Any one read of a frame (its geometry, its snapshot, a hit test). */
const FRAME_TIMEOUT_MS: number = 1_000;

/** Where a frame's controls are routed to, for one snapshot. */
export interface FrameRoute {
    /** 1, 2, … in the snapshot's frame order. */
    slot: number;
    frame: Frame;
    /** host[:port] of the frame's document. */
    host: string;
    /** How the model is told which frame a control is in (host first: the title is the page's). */
    label: string;
}

/** A frame read for one snapshot. */
export interface FrameRead {
    route: FrameRoute;
    raw: RuntimeSnapshot;
}

/** A frame control, as the snapshot that offered it routes it. */
export interface FrameControlRoute {
    route: FrameRoute;
    /** Its runtime id in the frame's document. */
    local: number;
}

/** Where a control lives: the document to run the runtime in, and its id there. */
export interface ControlTarget {
    runner: Page | Frame;
    local: number;
    /** Set for a frame control. */
    route?: FrameRoute;
}

/** Runs the runtime in a page or a frame (snapshot.ts's `runRuntime`). */
export type RuntimeRunner = (
    target: Page | Frame,
    req: RuntimeRequest
) => Promise<unknown>;

/** A box on the page. */
type Box = { x: number; y: number; width: number; height: number };

/** The id a frame control is offered under, or undefined past the id space. */
export function frameControlId(
    slot: number,
    local: number
): number | undefined {
    return local > 0 && local < FRAME_ID_STRIDE
        ? FRAME_ID_BASE + slot * FRAME_ID_STRIDE + local
        : undefined;
}

/**
 * Where a control lives, by the snapshot's own routes: a frame control's
 * frame, or the page. Undefined when the control's frame has gone.
 */
export function controlTarget(
    page: Page,
    routes: Map<number, FrameControlRoute> | undefined,
    id: number
): ControlTarget | undefined {
    const entry: FrameControlRoute | undefined = routes?.get(id);
    if (entry === undefined) {
        return { runner: page, local: id };
    }
    if (entry.route.frame.isDetached()) {
        return undefined;
    }
    return {
        runner: entry.route.frame,
        local: entry.local,
        route: entry.route,
    };
}

/**
 * `work`, or undefined once `ms` passed. Its late error is dropped; a late
 * result goes to `onLate` (a handle to dispose).
 */
export async function withTimeout<T>(
    work: Promise<T>,
    ms: number = FRAME_TIMEOUT_MS,
    onLate?: (late: T) => void
): Promise<T | undefined> {
    let settled: boolean = false;
    let timer: NodeJS.Timeout | undefined;
    const timeout: Promise<undefined> = new Promise<undefined>(
        (resolve: (v: undefined) => void): void => {
            timer = setTimeout((): void => resolve(undefined), ms);
        }
    );
    try {
        return await Promise.race([
            work.then(
                (value: T): T => {
                    if (settled) {
                        onLate?.(value);
                    }
                    return value;
                },
                (): undefined => undefined
            ),
            timeout,
        ]);
    } finally {
        settled = true;
        clearTimeout(timer);
    }
}

/** Disposes a handle that arrived after its wait gave up. */
function disposeLate(handle: { dispose(): Promise<void> } | null): void {
    handle?.dispose().catch((): void => {});
}

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return "";
    }
}

/** A frame element's box on the page and its viewport's, in page coordinates. */
interface FrameGeometry {
    box: Box;
    /** The frame's viewport on the page (inside borders and padding). */
    content: Box;
    /** Page pixels per frame CSS pixel (a transform or zoom on the way). */
    scaleX: number;
    scaleY: number;
}

async function geometry(frame: Frame): Promise<FrameGeometry | undefined> {
    let element: ElementHandle | null | undefined = null;
    try {
        element = await withTimeout(
            frame.frameElement(),
            FRAME_TIMEOUT_MS,
            disposeLate
        );
        if (!element) {
            return undefined;
        }
        const box: Box | null | undefined = await withTimeout(
            element.boundingBox()
        );
        if (!box) {
            return undefined;
        }
        const inner: number[] | undefined = await withTimeout(
            element.evaluate((e: Element): number[] => {
                const style: CSSStyleDeclaration = getComputedStyle(e);
                const html: HTMLElement = e as HTMLElement;
                const padLeft: number = parseFloat(style.paddingLeft) || 0;
                const padTop: number = parseFloat(style.paddingTop) || 0;
                const padRight: number = parseFloat(style.paddingRight) || 0;
                const padBottom: number = parseFloat(style.paddingBottom) || 0;
                return [
                    html.offsetWidth,
                    html.offsetHeight,
                    e.clientLeft + padLeft,
                    e.clientTop + padTop,
                    e.clientWidth - padLeft - padRight,
                    e.clientHeight - padTop - padBottom,
                ];
            })
        );
        if (!inner) {
            return undefined;
        }
        const [offsetW, offsetH, left, top, width, height]: number[] = inner;
        const scaleX: number = offsetW > 0 ? box.width / offsetW : 1;
        const scaleY: number = offsetH > 0 ? box.height / offsetH : 1;
        return {
            box,
            content: {
                x: box.x + left * scaleX,
                y: box.y + top * scaleY,
                width: width * scaleX,
                height: height * scaleY,
            },
            scaleX,
            scaleY,
        };
    } catch {
        return undefined;
    } finally {
        await element?.dispose().catch((): void => {});
    }
}

/**
 * The main document's visible frames (the first MAX_FRAMES in the order they attached),
 * each read with the runtime in parallel and within a timeout, told which part
 * of it the page shows. A frame that cannot be read (detached, navigating, no
 * body yet, too slow) is skipped: a snapshot never fails or waits because of
 * an embedded document.
 */
export async function readFrames(
    page: Page,
    run: RuntimeRunner,
    request: RuntimeRequest,
    viewport: { width: number; height: number }
): Promise<FrameRead[]> {
    const frames: Frame[] = page
        .mainFrame()
        .childFrames()
        .filter((f: Frame): boolean => !f.isDetached())
        .slice(0, MAX_FRAMES_MEASURED);
    const measured: (FrameGeometry | undefined)[] = await Promise.all(
        frames.map(
            (f: Frame): Promise<FrameGeometry | undefined> => geometry(f)
        )
    );
    const visible: { frame: Frame; geometry: FrameGeometry }[] = [];
    frames.forEach((frame: Frame, i: number): void => {
        const g: FrameGeometry | undefined = measured[i];
        if (
            g === undefined ||
            g.box.width < MIN_FRAME_SIDE ||
            g.box.height < MIN_FRAME_SIDE ||
            g.box.x + g.box.width <= 0 ||
            g.box.y + g.box.height <= 0 ||
            g.box.x >= viewport.width ||
            g.box.y >= viewport.height
        ) {
            return;
        }
        visible.push({ frame, geometry: g });
    });
    const reads: (FrameRead | null)[] = await Promise.all(
        visible
            .slice(0, MAX_FRAMES)
            .map(
                async (
                    v: { frame: Frame; geometry: FrameGeometry },
                    i: number
                ): Promise<FrameRead | null> => {
                    const g: FrameGeometry = v.geometry;
                    // The part of the frame's viewport the page shows, in frame pixels.
                    const left: number = Math.max(0, -g.content.x);
                    const top: number = Math.max(0, -g.content.y);
                    const right: number = Math.min(
                        g.content.width,
                        viewport.width - g.content.x
                    );
                    const bottom: number = Math.min(
                        g.content.height,
                        viewport.height - g.content.y
                    );
                    const clip: Box = {
                        x: left / g.scaleX,
                        y: top / g.scaleY,
                        width: Math.max(0, right - left) / g.scaleX,
                        height: Math.max(0, bottom - top) / g.scaleY,
                    };
                    const raw: RuntimeSnapshot | null | undefined =
                        (await withTimeout(
                            run(v.frame, {
                                ...request,
                                clip,
                            } as RuntimeRequest)
                        )) as RuntimeSnapshot | null | undefined;
                    if (!raw) {
                        return null;
                    }
                    const host: string = hostOf(v.frame.url());
                    // Cut with "…": the label reaches every control's context, and a secret in a
                    // title cut short is masked only when the cut is marked.
                    const title: string = cutText(raw.title.trim(), 60);
                    return {
                        route: {
                            slot: i + 1,
                            frame: v.frame,
                            host,
                            label: title
                                ? `${host || "frame"} "${title}"`
                                : host || "frame",
                        },
                        raw,
                    };
                }
            )
    );
    return reads.filter((r: FrameRead | null): r is FrameRead => r !== null);
}

/**
 * A point in a frame's viewport, on the page: through the frame's content box
 * and scale (borders, padding, a transform's scale, zoom). Undefined when the
 * frame's element cannot be measured.
 */
export async function framePointToPage(
    route: FrameRoute,
    x: number,
    y: number
): Promise<{ x: number; y: number } | undefined> {
    const g: FrameGeometry | undefined = await geometry(route.frame);
    if (g === undefined) {
        return undefined;
    }
    return { x: g.content.x + x * g.scaleX, y: g.content.y + y * g.scaleY };
}

/**
 * Whether the page shows the frame at a page point: in the viewport, and the
 * frame element is what is there (through open shadow roots on the way).
 */
export async function frameShownAt(
    route: FrameRoute,
    x: number,
    y: number
): Promise<boolean> {
    let element: ElementHandle<Element> | null | undefined = null;
    try {
        element = (await withTimeout(
            route.frame.frameElement(),
            FRAME_TIMEOUT_MS,
            disposeLate
        )) as ElementHandle<Element> | null | undefined;
        if (!element) {
            return false;
        }
        const shown: boolean | undefined = await withTimeout(
            element.evaluate(
                (e: Element, p: number[]): boolean => {
                    if (
                        p[0] < 0 ||
                        p[1] < 0 ||
                        p[0] >= innerWidth ||
                        p[1] >= innerHeight
                    ) {
                        return false;
                    }
                    let hit: Element | null = document.elementFromPoint(
                        p[0],
                        p[1]
                    );
                    // An iframe inside a shadow root: the document answers its host.
                    while (hit !== null && hit !== e && hit.shadowRoot) {
                        const inner: Element | null =
                            hit.shadowRoot.elementFromPoint(p[0], p[1]);
                        if (inner === null || inner === hit) {
                            break;
                        }
                        hit = inner;
                    }
                    return hit === e;
                },
                [x, y]
            )
        );
        return shown === true;
    } catch {
        return false;
    } finally {
        await element?.dispose().catch((): void => {});
    }
}
