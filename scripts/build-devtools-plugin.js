#!/usr/bin/env node
/**
 * Bundles src/devtools-plugin/ into dist/devtools-plugin/control-tools.mjs: the
 * agent's control tools as ONE ESM file IronBee DevTools loads with
 * TOOL_PLUGINS. Nothing is left to resolve — DevTools hands the plugin zod and
 * its building blocks at start-up; only Node built-ins are imported.
 *
 * Not minified and no keepNames: the page-side runtime is serialized into
 * `page.evaluate` (its source must stay self-contained and readable in errors).
 */

const fs = require("fs");
const path = require("path");
const { buildSync } = require("esbuild");

const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(repoRoot, "dist/devtools-plugin");

// The plugin ships only as the bundle: the per-module declarations `tsc
// --emitDeclarationOnly` wrote here describe nothing anyone imports.
if (fs.existsSync(outDir)) {
    for (const entry of fs.readdirSync(outDir)) {
        if (entry.endsWith(".d.ts")) {
            fs.rmSync(path.join(outDir, entry));
        }
    }
}

buildSync({
    entryPoints: [path.join(repoRoot, "src/devtools-plugin/index.ts")],
    outfile: path.join(outDir, "control-tools.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    minify: false,
    keepNames: false,
    // The plugin imports playwright-core and zod as TYPES only (the bundle's one
    // import is node:crypto; zod arrives through the plugin API). `external` is a
    // guard that must never be exercised: a runtime import left here would
    // resolve against THIS package's node_modules (dev dependencies, absent in a
    // production install), not DevTools' copies.
    external: ["playwright-core", "zod"],
    sourcemap: false,
    logLevel: "info",
});
