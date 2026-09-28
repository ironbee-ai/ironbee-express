/**
 * A control as a recording remembers it. Control ids are per page load, so a
 * replay finds its target again by what a person would: role, accessible
 * name, the nearby text that tells identical controls apart, and — when that
 * still leaves several — the position among them.
 */

import { Control, ControlSnapshot } from "../devtools/types";

export interface TargetDescriptor {
    role: string;
    name: string;
    /** Only for controls whose role + name repeat ("Edit" per row). */
    context?: string;
    /** Index among the controls with the same role, name and context, in page order. */
    ordinal: number;
}

function sameIdentity(a: { role: string; name: string }, b: { role: string; name: string }): boolean {
    return a.role === b.role && a.name === b.name;
}

export function describeTarget(control: Control, snapshot: ControlSnapshot): TargetDescriptor {
    const peers: Control[] = snapshot.controls.filter(
        (c: Control): boolean => sameIdentity(c, control) && c.context === control.context
    );
    return {
        role: control.role,
        name: control.name,
        ...(control.context !== undefined ? { context: control.context } : {}),
        ordinal: Math.max(0, peers.indexOf(control)),
    };
}

/** What a descriptor finds on a snapshot. */
export interface TargetLookup {
    /** The control the descriptor names, when the page leaves no doubt which one it is. */
    control?: Control;
    /**
     * Without a control: the controls of the descriptor's role and name when the page changed
     * around the recorded one — its context no longer matches (a price in it changed), or twins
     * appeared beside a control that had none. Which of them it is now is a reading, not a rule
     * (a number is sometimes a price and sometimes a model): the engine's (reidentify.ts). Empty
     * when no control has the role and name.
     */
    candidates: Control[];
}

/**
 * Finds a descriptor's control on this snapshot: exact context first; then context containment (a
 * badge added or dropped beside it); then position among the twins it was recorded among.
 */
export function lookupTarget(descriptor: TargetDescriptor, snapshot: ControlSnapshot): TargetLookup {
    const named: Control[] = snapshot.controls.filter((c: Control): boolean => sameIdentity(c, descriptor));
    if (named.length === 0) {
        return { candidates: [] };
    }
    if (descriptor.context === undefined) {
        // The same peers `describeTarget` counted: controls without a context. A twin that has
        // one is another control, not a shifted position.
        const bare: Control[] = named.filter((c: Control): boolean => c.context === undefined);
        if (bare.length > 0) {
            const control: Control | undefined = bare[descriptor.ordinal] ?? (named.length === 1 ? named[0] : undefined);
            return control ? { control, candidates: [] } : { candidates: [] };
        }
        // Recorded without a context, and now every twin has one: the page put twins beside it
        // (a promotion with the same button above it), and position no longer says which it was.
        return named.length === 1 ? { control: named[0], candidates: [] } : { candidates: named };
    }
    const exact: Control[] = named.filter((c: Control): boolean => c.context === descriptor.context);
    if (exact.length > 0) {
        return { control: exact[descriptor.ordinal] ?? exact[0], candidates: [] };
    }
    const wanted: string = descriptor.context.toLowerCase();
    const loose: Control[] = named.filter((c: Control): boolean => {
        const have: string = (c.context ?? "").toLowerCase();
        return have !== "" && (have.includes(wanted) || wanted.includes(have));
    });
    return loose.length === 1 ? { control: loose[0], candidates: [] } : { candidates: named };
}

/** The control a descriptor names on this snapshot, or undefined (see `lookupTarget`). */
export function findTarget(descriptor: TargetDescriptor, snapshot: ControlSnapshot): Control | undefined {
    return lookupTarget(descriptor, snapshot).control;
}

export function formatDescriptor(d: TargetDescriptor): string {
    return `${d.role} "${d.name}"${d.context ? ` (${d.context.slice(0, 60)})` : ""}`;
}
