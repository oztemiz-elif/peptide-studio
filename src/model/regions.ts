// Highlight-region overlap grouping. Ports check_overlap / group_overlapping_regions
// from main.py:189-205.

import { Range } from '../state/config';

export function checkOverlap(a: Range, b: Range): boolean {
  return Math.max(a[0], b[0]) <= Math.min(a[1], b[1]);
}

/**
 * Group regions so that overlapping regions land in different groups (rendered at
 * staggered heights). Greedy, sorted by start. Direct port of group_overlapping_regions.
 */
/** One row of the marked-region summary drawn under the coverage profile. */
export interface RegionSummary {
  label: string;
  start: number;
  end: number;
  colour: string;
  /** Peptides overlapping the region at all — how much material sits in that stretch. */
  peptideCount: number;
  /** Peptides whose N-terminus is exactly the region's first residue, and whose C-terminus is
   *  exactly its last. These are the evidence for where each boundary was put, and they read
   *  the same whether the region came from detection or was placed by hand. */
  nTerminalCleavage: number;
  cTerminalCleavage: number;
  /** Weakest, typical and strongest peptide in the region, each taken at its own best time
   *  point. The median leads because MS intensities are normally right-skewed: a handful of
   *  abundant peptides drag the mean up, so it reports the strongest species rather than the
   *  typical one — and the strongest is already `maxIntensity`. */
  minIntensity: number;
  medianIntensity: number;
  meanIntensity: number;
  maxIntensity: number;
  /**
   * Mean divided by median. Above 1 the spread leans right; the further above, the more the
   * mean is being carried by a few strong peptides. Reported instead of a normality verdict
   * because a yes/no test answers mostly according to how many peptides a region happens to
   * contain — near-certain "normal" for a small region, near-certain "not normal" for a large
   * one — which makes two rows of the same table incomparable. This ratio does not care.
   */
  skew: number;
  /** How many of those peptides are actually present at each time point, in the order the
   *  intensity columns were given. `peptideCount` pools every time point, which hides whether a
   *  region is there throughout or only appears late — this is that breakdown. */
  perColumn: number[];
  /** Whether the region's band is drawn across every time-point track. The per-time-point table
   *  is limited to these: a region marked on one track is not a claim about the others. */
  spanAll: boolean;
}

/** Above this the region is flagged as right-skewed and the median is the safer summary. */
export const SKEW_FLAG = 1.5;

/**
 * Whether a peptide belongs to a region [s, e], at a membership threshold in percent.
 *
 * Sharing a single residue is not membership: a peptide clipping the edge of a region by 2 aa
 * would otherwise weigh the same as one sitting squarely inside it. A peptide qualifies when
 * EITHER side of the pair is mostly shared —
 *
 *   - most of the REGION is covered, which keeps long peptides that run past both boundaries
 *     but genuinely span the stretch; or
 *   - most of the PEPTIDE is inside, which keeps short peptides that cannot possibly cover half
 *     of a long region yet plainly sit within it.
 *
 * Neither test alone is enough, and the pair is deliberately an OR: a peptide that contains the
 * region entirely passes the first test however long it is, because it does cover the stretch.
 *
 * Compared as integers (`o * 100 >= length * percent`) so no rounding rule is needed for
 * odd-length regions.
 */
export function inRegion(
  p: { start: number; end: number },
  s: number,
  e: number,
  percent: number,
): boolean {
  const o = Math.min(e, p.end) - Math.max(s, p.start) + 1;
  if (o <= 0) return false;
  const share = o * 100;
  return share >= (e - s + 1) * percent || share >= (p.end - p.start + 1) * percent;
}

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Summarise every marked region against the peptides currently visible. Kept in the model so
 * the figure-side panel and any future report read identical numbers.
 */
export function summariseRegions<P extends { start: number; end: number; intensity: Record<string, number> }>(
  regions: Range[],
  labels: string[],
  colours: string[],
  visible: P[],
  columns: string[],
  spanAll: boolean[] = [],
  /** Whether a peptide is shown at a given time point. The caller passes the figure's own filter
   *  test, so a per-time-point count can never disagree with the bands on screen; the default —
   *  any intensity at all — is what that test reduces to with no filters set. */
  passes: (p: P, col: string) => boolean = (p, col) => (p.intensity[col] ?? 0) > 0,
  membershipPercent = 50,
): RegionSummary[] {
  const peakOf = (p: { intensity: Record<string, number> }) =>
    columns.reduce((m, col) => Math.max(m, p.intensity[col] ?? 0), 0);

  return regions.map(([a, b], i) => {
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    const inside = visible.filter((p) => inRegion(p, start, end, membershipPercent));
    const peaks = inside.map(peakOf).sort((a, b) => a - b);
    const mid = median(peaks);
    const mean = peaks.length ? peaks.reduce((s, v) => s + v, 0) / peaks.length : 0;
    return {
      label: (labels[i] ?? '').trim() || `Region ${i + 1}`,
      start,
      end,
      colour: colours[i] ?? '#334155',
      peptideCount: inside.length,
      nTerminalCleavage: visible.filter((p) => p.start === start).length,
      cTerminalCleavage: visible.filter((p) => p.end === end).length,
      minIntensity: peaks.length ? peaks[0] : 0,
      medianIntensity: mid,
      meanIntensity: mean,
      maxIntensity: peaks.length ? peaks[peaks.length - 1] : 0,
      skew: mid > 0 ? mean / mid : 0,
      perColumn: columns.map((col) => inside.reduce((n, p) => n + (passes(p, col) ? 1 : 0), 0)),
      spanAll: spanAll[i] ?? false,
    };
  });
}

export function groupOverlappingRegions(regions: Range[]): Range[][] {
  const sorted = [...regions].sort((a, b) => a[0] - b[0]);
  const groups: Range[][] = [];
  for (const region of sorted) {
    let placed = false;
    for (const group of groups) {
      if (group.every((r) => !checkOverlap(region, r))) {
        group.push(region);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([region]);
  }
  return groups;
}

/** Parse "10-20, 30-40" into ranges (mirrors the sidebar parser in main.py:1564-1569). */
export function parseHighlightRegions(input: string): Range[] {
  if (!input.trim()) return [];
  const out: Range[] = [];
  for (const part of input.split(',')) {
    const m = part.trim().split('-');
    if (m.length === 2) {
      const a = parseInt(m[0], 10);
      const b = parseInt(m[1], 10);
      if (Number.isFinite(a) && Number.isFinite(b)) out.push([a, b]);
    }
  }
  return out;
}

/** Parse "1,3,5-7,10" into a set of integers. Ports parse_amino_acid_indices (main.py:20-48). */
export function parseIndices(input: string): number[] {
  if (!input.trim()) return [];
  const result = new Set<number>();
  for (const rawPart of input.split(',')) {
    const part = rawPart.trim();
    if (part.includes('-')) {
      const [a, b] = part.split('-').map((x) => parseInt(x, 10));
      if (Number.isFinite(a) && Number.isFinite(b)) {
        for (let i = a; i <= b; i++) result.add(i);
      }
    } else {
      const n = parseInt(part, 10);
      if (Number.isFinite(n)) result.add(n);
    }
  }
  return [...result].sort((a, b) => a - b);
}
