// Cleavage counted per peptide bond rather than per residue.
//
// A terminus names a bond, not a position, and the two termini that name the same bond sit on
// different residues: a peptide FINISHING at residue i and a peptide BEGINNING at residue i+1
// are the two products of one cut, between i and i+1. Adding "peptides ending at i" to
// "peptides starting at i" would therefore sum two unrelated bonds, which is why nothing here
// is indexed by residue.
//
// Naming follows the Schechter and Berger convention: for the bond between i and i+1, residue i
// is P1 and residue i+1 is P1'. The module reports how many peptide termini support each bond
// and stops there — whether that constitutes a protease site is the reader's call.
//
// Bonds run 1-2 to (L-1)-L, so a peptide starting at residue 1, or ending at the last residue,
// contributes to no bond at all. That is deliberate: those are the protein's own termini, not
// cleavages.

/** One peptide bond, with the evidence for it at each time point. */
export interface CleavageBond {
  /** The P1 residue, 1-based. The bond is between this residue and the next. */
  p1: number;
  /** One-letter codes for P1 and P1'. */
  p1aa: string;
  p1PrimeAa: string;
  /** Peptides finishing at P1, per time point, in the order the columns were given. */
  fromC: number[];
  /** Peptides beginning at P1', per time point. */
  fromN: number[];
  /** fromC + fromN: every peptide terminus supporting this bond at that time point. */
  total: number[];
  /** The same three, with each peptide counted once across the whole experiment. */
  pooledFromC: number;
  pooledFromN: number;
  pooledTotal: number;
}

/**
 * Tally every bond in the sequence. One pass over the peptides per time point, then one pass
 * over the sequence, so the cost is (peptides x time points + length) however long the protein.
 *
 * `passes` is the caller's test for whether a peptide is present at a time point — the figure's
 * own filter, so a bond's count is the number of termini actually drawn on that track.
 */
export function buildCleavageTable<P extends { start: number; end: number }>(
  visible: P[],
  seq: string,
  columns: string[],
  passes: (p: P, col: string) => boolean,
): CleavageBond[] {
  const L = seq.length;
  if (L < 2 || !columns.length) return [];

  const zeros = () => new Array<number>(L + 2).fill(0);
  const starts = columns.map(zeros);
  const ends = columns.map(zeros);
  const pooledStarts = zeros();
  const pooledEnds = zeros();

  for (const p of visible) {
    const inSeq = (r: number) => r >= 1 && r <= L;
    if (inSeq(p.start)) pooledStarts[p.start]++;
    if (inSeq(p.end)) pooledEnds[p.end]++;
    for (let ci = 0; ci < columns.length; ci++) {
      if (!passes(p, columns[ci])) continue;
      if (inSeq(p.start)) starts[ci][p.start]++;
      if (inSeq(p.end)) ends[ci][p.end]++;
    }
  }

  const bonds: CleavageBond[] = [];
  for (let i = 1; i < L; i++) {
    const fromC = columns.map((_, ci) => ends[ci][i]);
    const fromN = columns.map((_, ci) => starts[ci][i + 1]);
    bonds.push({
      p1: i,
      p1aa: seq[i - 1] ?? '',
      p1PrimeAa: seq[i] ?? '',
      fromC,
      fromN,
      total: fromC.map((v, ci) => v + fromN[ci]),
      pooledFromC: pooledEnds[i],
      pooledFromN: pooledStarts[i + 1],
      pooledTotal: pooledEnds[i] + pooledStarts[i + 1],
    });
  }
  return bonds;
}
