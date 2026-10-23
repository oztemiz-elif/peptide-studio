// Per-residue profiles behind the coverage panel: how many peptides cover each residue, and
// how many begin or end on it. The terminus tallies are the same numbers cluster detection
// anchors on, so the panel shows exactly what the detector sees rather than an approximation.
//
// Everything here is O(peptides + protein length) and independent of how wide the local
// window is: coverage is accumulated through a difference array and the local means come from
// running totals, so no residue is ever visited more than a constant number of times. That
// matters because the panel is rebuilt on every settings change.

import { Peptide } from './peptides';

export interface ResidueProfile {
  /** 1-based, index 0 unused, so `coverage[res]` reads directly. */
  coverage: number[];
  starts: number[];
  ends: number[];
  /** Mean starts (ends) per residue over the window around each position — the baseline the
   *  enrichment factor is applied to. */
  avgStarts: number[];
  avgEnds: number[];
  maxCoverage: number;
  /** Largest single start or end tally, so both halves of the panel share one scale. */
  maxTerminus: number;
  peptideCount: number;
}

/** Running totals, so a window sum is one subtraction rather than a loop. */
function runningTotals(counts: number[], seqLength: number): number[] {
  const out = new Array<number>(seqLength + 1).fill(0);
  for (let i = 1; i <= seqLength; i++) out[i] = out[i - 1] + (counts[i] ?? 0);
  return out;
}

/**
 * Build every per-residue series the panel draws. `window` is the radius of the neighbourhood
 * used for the local means — pass the cluster maximum length, which is what detection uses,
 * so the threshold drawn on the panel is the one actually applied.
 */
export function buildResidueProfile(
  peptides: Peptide[],
  seqLength: number,
  window: number,
): ResidueProfile {
  const zeros = () => new Array<number>(seqLength + 2).fill(0);
  const coverage = zeros();
  const starts = zeros();
  const ends = zeros();

  const delta = zeros();
  for (const p of peptides) {
    const s = Math.max(1, p.start);
    const e = Math.min(seqLength, p.end);
    if (s > e) continue;
    delta[s] += 1;
    delta[e + 1] -= 1;
    if (p.start >= 1 && p.start <= seqLength) starts[p.start] += 1;
    if (p.end >= 1 && p.end <= seqLength) ends[p.end] += 1;
  }
  let running = 0;
  let maxCoverage = 0;
  for (let res = 1; res <= seqLength; res++) {
    running += delta[res];
    coverage[res] = running;
    if (running > maxCoverage) maxCoverage = running;
  }

  const totalStarts = runningTotals(starts, seqLength);
  const totalEnds = runningTotals(ends, seqLength);
  const radius = Math.max(1, Math.round(window));
  const avgStarts = zeros();
  const avgEnds = zeros();
  for (let res = 1; res <= seqLength; res++) {
    const lo = Math.max(1, res - radius);
    const hi = Math.min(seqLength, res + radius);
    const span = hi - lo + 1;
    avgStarts[res] = (totalStarts[hi] - totalStarts[lo - 1]) / span;
    avgEnds[res] = (totalEnds[hi] - totalEnds[lo - 1]) / span;
  }

  let maxTerminus = 0;
  for (let res = 1; res <= seqLength; res++) {
    if (starts[res] > maxTerminus) maxTerminus = starts[res];
    if (ends[res] > maxTerminus) maxTerminus = ends[res];
  }

  return {
    coverage,
    starts,
    ends,
    avgStarts,
    avgEnds,
    maxCoverage,
    maxTerminus,
    peptideCount: peptides.length,
  };
}

/** True where a position carries enough termini, and enough relative to its neighbourhood,
 *  to anchor a cluster — the same test `detectClusters` applies. */
export function anchorFlags(
  counts: number[],
  averages: number[],
  seqLength: number,
  minShared: number,
  enrichmentFactor: number,
): boolean[] {
  const out = new Array<boolean>(seqLength + 1).fill(false);
  for (let res = 1; res <= seqLength; res++) {
    const here = counts[res] ?? 0;
    out[res] = here >= minShared && here >= enrichmentFactor * (averages[res] ?? 0);
  }
  return out;
}

/**
 * How many residues each drawn bar stands for. One bar per residue is the honest rendering,
 * but a very long protein would put tens of thousands of SVG nodes on screen and make every
 * settings change stutter, so past `budget` positions the bars aggregate and the panel says
 * so. `budget` is a node count, not a length limit — nothing is hidden, only merged.
 */
export function binSize(seqLength: number, budget = 1200): number {
  return Math.max(1, Math.ceil(seqLength / budget));
}
