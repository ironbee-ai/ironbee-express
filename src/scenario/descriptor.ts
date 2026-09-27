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

/**
 * The control a descriptor names on this snapshot, or undefined. Exact
 * context first; then context containment (a price or stock badge may have
 * changed); then position.
 */
export function findTarget(descriptor: TargetDescriptor, snapshot: ControlSnapshot): Control | undefined {
    const named: Control[] = snapshot.controls.filter((c: Control): boolean => sameIdentity(c, descriptor));
    if (named.length === 0) {
        return undefined;
    }
    if (descriptor.context === undefined) {
        // The same peers `describeTarget` counted: controls without a context. A twin that has
        // one is another control, not a shifted position.
        const bare: Control[] = named.filter((c: Control): boolean => c.context === undefined);
        return (bare.length > 0 ? bare : named)[descriptor.ordinal] ?? (named.length === 1 ? named[0] : undefined);
    }
    const exact: Control[] = named.filter((c: Control): boolean => c.context === descriptor.context);
    if (exact.length > 0) {
        return exact[descriptor.ordinal] ?? exact[0];
    }
    const wanted: string = descriptor.context.toLowerCase();
    const loose: Control[] = named.filter((c: Control): boolean => {
        const have: string = (c.context ?? "").toLowerCase();
        return have !== "" && (have.includes(wanted) || wanted.includes(have));
    });
    return loose.length === 1 ? loose[0] : undefined;
}

export function formatDescriptor(d: TargetDescriptor): string {
    return `${d.role} "${d.name}"${d.context ? ` (${d.context.slice(0, 60)})` : ""}`;
}
