/**
 * DevTools settings the control tools follow, read from the env the way
 * DevTools reads them (a flag is on for "true", "1", "yes" or "on", in any
 * case): the plugin runs in DevTools' own process.
 */

function flag(name: string): boolean | undefined {
    const v: string | undefined = process.env[name]?.trim();
    return v ? /^(?:true|1|yes|on)$/i.test(v) : undefined;
}

/** The session follows the tabs its page opens (a target=_blank link waits for its tab). */
export function followsNewTabs(): boolean {
    return flag("BROWSER_FOLLOW_NEW_TABS") ?? false;
}

/** Marks actions on the page: forced on / off, or undefined = while a recording runs. */
export function actionAnimation(): boolean | undefined {
    return flag("BROWSER_ACTION_ANIMATION");
}

/** Controls inside the page's iframes too. */
export function snapshotFrames(): boolean {
    return flag("BROWSER_CONTROL_SNAPSHOT_FRAMES") ?? false;
}
