/** Fitting lines of evidence text into a character budget without cutting one in the middle. */

/** The first lines that fit `max` characters (with their newlines); a first line longer than that is cut. */
export function headLines(lines: string[], max: number): string[] {
    const kept: string[] = [];
    let used: number = 0;
    for (const line of lines) {
        const cost: number = line.length + (kept.length ? 1 : 0);
        if (used + cost > max) {
            if (kept.length === 0 && max > 0) {
                kept.push(line.slice(0, max));
            }
            break;
        }
        kept.push(line);
        used += cost;
    }
    return kept;
}

/** The last lines that fit `max` characters: the latest are the ones kept. */
export function tailLines(lines: string[], max: number): string[] {
    return headLines([...lines].reverse(), max).reverse();
}

/** The characters `lines` take joined, a newline after each. */
export function linesSize(lines: string[]): number {
    return lines.reduce((n: number, line: string): number => n + line.length + 1, 0);
}
