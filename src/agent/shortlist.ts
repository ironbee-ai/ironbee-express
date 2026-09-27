/**
 * Keeps the controls most likely to matter when an engine can only take a few
 * options per question (a small-context engine packs every option into a short head).
 *
 * Score: the goal's words (and the hints a rejected DONE gave) a control
 * mentions, each weighted by rarity across the page's controls — a name on one
 * card beats a word on forty — plus a small prior for empty fields. No word
 * list: what a button is for is the engine's reading of its offered text. A
 * group of identical controls ("Edit" per row) may take only a few of the
 * slots, so navigation is not crowded out. Ties keep page order; the result is
 * in page order. Deterministic.
 */

import { Control, ControlOperation } from "../devtools/types";

/** Share of the slots one group of identical controls may take (at least 3). */
const GROUP_SHARE: number = 0.25;

function tokens(text: string): Set<string> {
    return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

function ownTokens(control: Control): Set<string> {
    return tokens(`${control.name} ${control.context ?? ""} ${control.value ?? ""}`);
}

/** Relevance of one control; `df` = how many controls mention each token. */
export function relevance(control: Control, query: Set<string>, df: Map<string, number> = new Map()): number {
    let score: number = 0;
    for (const t of ownTokens(control)) {
        if (query.has(t)) {
            score += 2 / Math.max(1, df.get(t) ?? 1);
        }
    }
    if (control.ops.includes(ControlOperation.FILL) && !control.value && !control.filled) {
        score += 0.5;
    }
    return score;
}

/** The `max` most relevant controls, in page order. */
export function shortlistControls(controls: Control[], goalAndHints: string, max: number): Control[] {
    if (controls.length <= max) {
        return controls;
    }
    const query: Set<string> = tokens(goalAndHints);
    const df: Map<string, number> = new Map();
    for (const control of controls) {
        for (const t of ownTokens(control)) {
            df.set(t, (df.get(t) ?? 0) + 1);
        }
    }
    const groupCap: number = Math.max(3, Math.floor(max * GROUP_SHARE));
    const ranked: Array<{ control: Control; score: number; index: number }> = controls
        .map((control: Control, index: number): { control: Control; score: number; index: number } => ({
            control,
            score: relevance(control, query, df),
            index,
        }))
        .sort(
            (a: { score: number; index: number }, b: { score: number; index: number }): number =>
                b.score - a.score || a.index - b.index
        );
    const perGroup: Map<string, number> = new Map();
    const kept: Array<{ control: Control; index: number }> = [];
    for (const entry of ranked) {
        if (kept.length >= max) {
            break;
        }
        const group: string = `${entry.control.role}\u0000${entry.control.name}`;
        const taken: number = perGroup.get(group) ?? 0;
        if (taken >= groupCap) {
            continue;
        }
        perGroup.set(group, taken + 1);
        kept.push(entry);
    }
    return kept
        .sort((a: { index: number }, b: { index: number }): number => a.index - b.index)
        .map((r: { control: Control }): Control => r.control);
}
