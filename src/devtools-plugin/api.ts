/**
 * The plugin API DevTools handed this plugin at start-up — the common part
 * (its zod, logger, `carriesSecretReference`, `resolveSecrets`) from the
 * factory. Read through here, after index.ts set it. The browser platform's
 * own part (`resolveElement`) is handed to the browser tools' builder and not
 * kept: the control tools address elements by their own ids.
 */

import type { PluginApi } from "./host";

let common: PluginApi | undefined;

export function setPluginApi(api: PluginApi): void {
    common = api;
}

export function pluginApi(): PluginApi {
    if (!common) {
        throw new Error("the control tools plugin is used before DevTools loaded it");
    }
    return common;
}
