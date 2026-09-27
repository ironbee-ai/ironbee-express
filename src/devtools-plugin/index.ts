/**
 * The agent's control tools as an IronBee DevTools tool plugin: DevTools loads
 * this module at start-up (TOOL_PLUGINS=<path to the built control-tools.mjs>)
 * and registers its tools beside its own, in the browser session they act on.
 *
 * - `control_take-snapshot`: the visible, enabled controls in the viewport,
 *   each with a stable id, role, name, state and the operations it takes.
 * - `control_act`: one guarded action on a control of the latest snapshot,
 *   returning the next one.
 *
 * Built by scripts/build-devtools-plugin.js into one ESM file with nothing to
 * resolve: DevTools hands it zod and `resolveSecrets` (api.ts); Playwright
 * comes with the session. The dialog race, the action marks and the settings
 * it follows are the plugin's own (dialog-race.ts, overlay.ts, settings.ts).
 */

import { Act } from "./act";
import { setPluginApi } from "./api";
import { BrowserPluginApi, PLUGIN_API_VERSION, PlatformTools, PluginApi, SecretSinkKind, ToolPlugin } from "./host";
import { TakeSnapshot } from "./take-snapshot";

export default function controlToolsPlugin(api: PluginApi): ToolPlugin {
    setPluginApi(api);
    return {
        name: "ironbee-express control tools",
        apiVersion: PLUGIN_API_VERSION,
        platforms: {
            // The browser's own API (resolveElement) is not used: the tools
            // address elements by their own ids.
            browser: (_platformApi: BrowserPluginApi): PlatformTools => ({
                tools: [new TakeSnapshot(), new Act()],
                // A fill's value may be a {{secret:…}} reference, typed into a page
                // element: resolved through DevTools' resolveSecrets for that element.
                secretSinks: { control_act: SecretSinkKind.FORM_FILL },
            }),
        },
    };
}
