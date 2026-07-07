// Peptide types and greedy row packing.

export interface Peptide {
  start: number; // 1-based inclusive
  end: number; // 1-based inclusive
  intensity: Record<string, number>;
  seq?: string;
}

/** Stable unique identifier for a peptide ("start-end"). Ports get_peptide_identifier. */
export function peptideId(p: { start: number; end: number }): string {
  return `${p.start}-${p.end}`;
}

/**
 * Greedy row assignment so overlapping peptides land on different rows.
 * Direct port of assign_rows() from main.py:156-168.
 * Peptides are placed on the first row where they don't touch/overlap any member
 * (a 1-residue gap is also required, matching the original `+ 1 / - 1` guards).
 *
 * An optional `sortFn` overrides the default (start asc, length desc) order — used
 * by the icicle layout to guarantee longest peptides get the lowest row index.
 */
export function assignRows<T extends { start: number; end: number }>(
  peptides: T[],
  sortFn?: (a: T, b: T) => number,
): T[][] {
  const sorted = [...peptides].sort(
    sortFn ?? ((a, b) => a.start - b.start || b.end - a.end),
  );
  const rows: T[][] = [];
  for (const peptide of sorted) {
    let placed = false;
    for (const row of rows) {
      const fits = row.every(
        (p) => peptide.start > p.end + 1 || peptide.end < p.start - 1,
      );
      if (fits) {
        row.push(peptide);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([peptide]);
  }
  return rows;
}

/** Sequence substring for a peptide (1-based inclusive coordinates). */
export function peptideSequence(proteinSeq: string, start: number, end: number): string {
  return proteinSeq.slice(start - 1, end);
}
