/**
 * Races a piece of work against a native dialog being held open
 * (BROWSER_DIALOG_MODE=hold). A held dialog stops the page's JavaScript, so
 * work that evaluates in the page would wait on it until it is answered or
 * times out: the race returns "a dialog opened" instead, the moment one is.
 * Built on the session's dialog keeper (`context.dialogs().whenOpened`); in the
 * other modes no dialog is ever held and the work simply runs.
 */

import type { DialogKeeper, RaceOutcome } from "./host";

export async function raceDialog<T>(keeper: DialogKeeper, work: Promise<T>): Promise<RaceOutcome<T>> {
    if (keeper.mode !== "hold") {
        return { dialog: false, value: await work };
    }
    const opened: { promise: Promise<void>; cancel: () => void } = keeper.whenOpened();
    try {
        return await Promise.race([
            work.then((value: T): { dialog: false; value: T } => ({ dialog: false, value })),
            opened.promise.then((): { dialog: true } => {
                work.catch((): void => {});
                return { dialog: true };
            }),
        ]);
    } finally {
        opened.cancel();
    }
}
