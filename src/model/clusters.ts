// Detection of peptide clusters — families of peptides that share a terminus, the pattern
// left behind when one species is progressively trimmed from the other end.
//
// Everything here stays descriptive: the module reports where peptides agree on a position,
// never why. Interpreting a shared start/end as a cut site is the reader's call, not the
// tool's, so no output or identifier claims one.
//
// TERMINOLOGY
//   shared start/end   a position where several peptides begin (or finish) together
//   family             the peptides sharing one such position
//   anchor             the shared position a cluster is built out from
//   far edge           the cluster's other edge, decided from the family's spread
//   trimming           reserved for the biology, never for anything done to a boundary
//
// WHY TERMINI AND NOT DENSITY
// An earlier version found dense stretches first and worked out their edges afterwards. That
// is backwards: density is what a family looks like from a distance, not what it is, and any
// threshold on it has to be relative to something. Relative to the protein's own maximum, one
// enormous hotspot raises the bar everywhere else and quietly hides real clusters; relative to
// an absolute count, the same setting means different things in a shallow and a deep dataset.
// Several peptides agreeing on a position is a fact about the data that holds at any depth, so
// it is the primary signal here and density plays no part.
//
// The cost of that choice: a region where peptides pile up with no repeated terminus anywhere
// — genuinely ragged at both ends — is not reported at all. That is deliberate. Such a region
// has no edges anyone could defend, and inventing them from a threshold is what went wrong
// before.

import { Config } from '../state/config';
import { IntensityScale, passesFilters } from './filtering';
import { Peptide } from './peptides';
import { inRegion } from './regions';

/** Which side of a cluster the family was anchored on. */
export type ClusterSide = 'start' | 'end';

/** How a cluster's far edge was decided. */
export type FarEdgeRule =
  /** Enough of the family finished at one position for it to be a real second edge. */
  | 'shared'
  /**
   * The family's far ends were spread — a staircase — so the edge is the furthest position
   * still reached by at least `minSharedPeptides` of its members. A single peptide reaching
   * well beyond its siblings cannot drag the boundary out on its own.
   */
  | 'longest'
  /** Every member of the family overshoots the maximum length, so there was no peptide
   *  terminus to land on and the edge is the limit itself. */
  | 'capped';

export interface ClusterParams {
  /** Shortest cluster to report, in residues. */
  minLength: number;
  /**
   * Longest cluster to report, in residues. Not a filter on peptides — it limits which family
   * members may define the far edge. If a family's longest member runs 35 residues and this
   * is 32, the edge falls back to the longest member that does fit within 32, so it stays a
   * real peptide terminus rather than an arbitrary cut at the limit.
   */
  maxLength: number;
  /**
   * How many peptides must begin (or finish) at a position before it counts as shared. Also
   * the support a far edge needs: on a staircase the edge is drawn where this many members
   * still reach, so no boundary in the result ever rests on a single peptide.
   */
  minSharedPeptides: number;
  /**
   * How many times the local average a position must carry to count as an anchor. Compared
   * against the average over a cluster-length neighbourhood, never against the protein's
   * global maximum — so the same setting behaves the same way in a shallow and a deep
   * dataset, and one hotspot cannot raise the bar for the rest of the protein.
   */
  enrichmentFactor: number;
  /**
   * What share of a family must finish at one position for that position to be treated as a
   * real second edge. Below it the family is a staircase, and the longest member is used
   * instead. A fraction of the family, so it means the same thing at any depth.
   */
  concentrationPercent: number;
   /**
   * How much *partial* overlap makes two clusters the same finding, as a percentage of the
   * shorter one's own length. Only applies between clusters of comparable length; full
   * containment is governed by `hierarchical` instead and is always removed when that is off,
   * at any setting here.
   */
  mergeOverlapPercent: number;
  /**
   * How to report a sub-cluster that sits inside a larger one and shares a terminus with it —
   * a species derived from the same parent. false merges it into the parent and reports one
   * cluster; true keeps both and records the relationship.
   */
  hierarchical: boolean;
  /**
   * How much a peptide and a cluster have to share before the peptide is counted as one of the
   * cluster's — see `inRegion` in ./regions. It decides `peptideCount`, which is also what
   * competing findings are ranked by, so raising it does not merely report smaller numbers: a
   * cluster held up mostly by peptides that clip its edges loses to one whose peptides sit
   * inside it.
   */
  membershipPercent: number;
}

export interface DetectedCluster {
  /** 1-based inclusive range. */
  start: number;
  end: number;
  /** Which edge is the anchor — the position the family agrees on. */
  anchoredOn: ClusterSide;
  /** The anchor position, and how many peptides share it. */
  anchor: number;
  anchorCount: number;
  /** How the opposite edge was decided, and how many peptides agreed on it ('shared' only). */
  farEdge: FarEdgeRule;
  farCount: number;
  /** Peptides overlapping the range. */
  peptideCount: number;
  /** Family members short enough to fit within the maximum length — those eligible to define
   *  the far edge. Fewer than `anchorCount` when some members overshoot. */
  familySize: number;
  /**
   * Weakest and strongest peptide in the cluster. Each peptide is taken at its own highest
   * time point, so these are the range of peptide abundances the cluster spans, not the range
   * over time of any one peptide. Reported for reference only — intensity plays no part in
   * deciding what is a cluster.
   */
  minIntensity: number;
  maxIntensity: number;
  /**
   * Index in the returned array of the cluster this one was derived from, or null for a
   * top-level cluster. Only ever set when `hierarchical` is on; merging removes children.
   */
  parent: number | null;
}

/**
 * How many clusters you get is governed almost entirely by two numbers — how many peptides
 * must share a position, and how far it must stand out from its surroundings. They always
 * move together in practice, so the panel offers them as one dial and keeps the rest out of
 * the way. The steps below are the pairs; anything else the user types is simply "custom".
 *
 * The middle step is 3 peptides at 3x. Both are deliberate: two peptides agreeing is not a
 * pattern, and a genuine pile-up tends to clear its local background by only a small multiple,
 * so a 4x or 5x bar starts cutting real clusters by a hair. The dial exists precisely because
 * the right setting is dataset-dependent — these are a starting point, not a claim.
 */
export interface SensitivityStep {
  label: string;
  minSharedPeptides: number;
  enrichmentFactor: number;
}

export const SENSITIVITY: SensitivityStep[] = [
  { label: 'Strictest', minSharedPeptides: 5, enrichmentFactor: 5 },
  { label: 'Strict', minSharedPeptides: 4, enrichmentFactor: 4 },
  { label: 'Balanced', minSharedPeptides: 3, enrichmentFactor: 3 },
  { label: 'Inclusive', minSharedPeptides: 3, enrichmentFactor: 2 },
  { label: 'Widest', minSharedPeptides: 2, enrichmentFactor: 1.5 },
];

/** Index of the step matching these two values, or -1 when they were set by hand. */
export function sensitivityLevel(minSharedPeptides: number, enrichmentFactor: number): number {
  return SENSITIVITY.findIndex(
    (s) => s.minSharedPeptides === minSharedPeptides && s.enrichmentFactor === enrichmentFactor,
  );
}

export function defaultClusterParams(): ClusterParams {
  const balanced = SENSITIVITY[2];
  return {
    minLength: 8,
    maxLength: 30,
    minSharedPeptides: balanced.minSharedPeptides,
    enrichmentFactor: balanced.enrichmentFactor,
    concentrationPercent: 40,
    mergeOverlapPercent: 80,
    hierarchical: false,
    membershipPercent: 50,
  };
}

export interface ClusterResult {
  clusters: DetectedCluster[];
  /** Positions that passed the shared-and-enriched test, per side. */
  sharedStarts: number;
  sharedEnds: number;
}

/** Peptides drawn at one or more of the given time points under the active filters. */
export function visiblePeptides(
  peptides: Peptide[],
  columns: string[],
  config: Config,
  scale: IntensityScale,
): Peptide[] {
  return peptides.filter((p) => columns.some((col) => passesFilters(p, col, config, scale)));
}

const span = (a: number, b: number) => Math.abs(b - a) + 1;

/** Running totals so a neighbourhood sum costs one subtraction instead of a loop. */
function prefixSums(counts: Map<number, number>, seqLength: number): number[] {
  const out = new Array<number>(seqLength + 1).fill(0);
  for (let i = 1; i <= seqLength; i++) out[i] = out[i - 1] + (counts.get(i) ?? 0);
  return out;
}

/**
 * Detect clusters across all the given time points pooled together, so one set of regions
 * describes the whole experiment rather than any single track.
 *
 * Returned clusters are ordered by position and may overlap.
 */
export function detectClusters(
  peptides: Peptide[],
  seqLength: number,
  columns: string[],
  config: Config,
  scale: IntensityScale,
  params: ClusterParams,
): ClusterResult {
  const empty: ClusterResult = { clusters: [], sharedStarts: 0, sharedEnds: 0 };
  if (seqLength <= 0 || !columns.length) return empty;

  const maxLen = Math.max(1, params.maxLength);
  const minLen = Math.max(1, Math.min(params.minLength, maxLen));
  const minShared = Math.max(1, params.minSharedPeptides);
  const factor = Math.max(0, params.enrichmentFactor);
  const concentration = Math.min(100, Math.max(1, params.concentrationPercent)) / 100;
  const share = Math.min(100, Math.max(1, params.mergeOverlapPercent)) / 100;
  const membership = Math.min(100, Math.max(1, params.membershipPercent));

  const visible = visiblePeptides(peptides, columns, config, scale);
  if (!visible.length) return empty;

  const startCounts = new Map<number, number>();
  const endCounts = new Map<number, number>();
  const byStart = new Map<number, Peptide[]>();
  const byEnd = new Map<number, Peptide[]>();
  const push = (m: Map<number, Peptide[]>, key: number, p: Peptide) => {
    const at = m.get(key);
    if (at) at.push(p);
    else m.set(key, [p]);
  };
  for (const p of visible) {
    startCounts.set(p.start, (startCounts.get(p.start) ?? 0) + 1);
    endCounts.set(p.end, (endCounts.get(p.end) ?? 0) + 1);
    push(byStart, p.start, p);
    push(byEnd, p.end, p);
  }
  const startPrefix = prefixSums(startCounts, seqLength);
  const endPrefix = prefixSums(endCounts, seqLength);

  const peakOf = (p: Peptide) =>
    columns.reduce((m, col) => Math.max(m, p.intensity[col] ?? 0), 0);

  /**
   * A position anchors a cluster when enough peptides share it AND it stands out against its
   * own neighbourhood. The local comparison is what makes the setting portable: a busy
   * protein raises its own baseline, so the same factor is neither trivial there nor
   * unreachable on a sparse one.
   */
  const isAnchor = (pos: number, counts: Map<number, number>, prefix: number[]): boolean => {
    const here = counts.get(pos) ?? 0;
    if (here < minShared) return false;
    const lo = Math.max(1, pos - maxLen);
    const hi = Math.min(seqLength, pos + maxLen);
    const average = (prefix[hi] - prefix[lo - 1]) / (hi - lo + 1);
    return here >= factor * average;
  };

  /**
   * Build the cluster anchored at `pos`. The far edge comes from how the family's opposite
   * termini are distributed: concentrated on one position means a genuine second edge, spread
   * out means a staircase whose far end is wherever its longest member reaches.
   */
  const build = (pos: number, side: ClusterSide): DetectedCluster | null => {
    const family = (side === 'start' ? byStart : byEnd).get(pos) ?? [];
    if (!family.length) return null;

    const farOf = (p: Peptide) => (side === 'start' ? p.end : p.start);
    // Only members that fit inside the maximum length may define the far edge. Choosing among
    // them — rather than picking the longest member and then trimming it back to the limit —
    // keeps the edge on a real peptide terminus instead of an arbitrary position.
    const fitting = family.filter((p) => span(pos, farOf(p)) <= maxLen);

    let far: number;
    let capped = false;
    let concentrated = false;
    let modeCount = 0;

    if (!fitting.length) {
      // Even the shortest member overshoots, so there is no terminus to land on.
      far = side === 'start' ? pos + maxLen - 1 : pos - maxLen + 1;
      capped = true;
    } else {
      const spreadCounts = new Map<number, number>();
      for (const p of fitting) spreadCounts.set(farOf(p), (spreadCounts.get(farOf(p)) ?? 0) + 1);

      let modePos = farOf(fitting[0]);
      for (const [at, count] of spreadCounts) {
        // On a tie take the further position, which keeps more of the staircase rather than
        // stopping at its first step.
        const further = side === 'start' ? at > modePos : at < modePos;
        if (count > modeCount || (count === modeCount && further)) {
          modePos = at;
          modeCount = count;
        }
      }
      concentrated = modeCount >= minShared && modeCount / fitting.length >= concentration;
      // Spread family: draw the edge where the staircase actually thins out, not at its one
      // furthest peptide. Sorting the far termini outward and stepping in `minShared` places
      // gives the last position that many members still reach — the same "more than one
      // peptide must agree" rule the anchors are held to, applied to the other edge.
      const outward = fitting
        .map(farOf)
        .sort((a, b) => (side === 'start' ? b - a : a - b));
      const supported = outward[Math.min(minShared, outward.length) - 1];
      far = concentrated ? modePos : supported;
    }

    const start = side === 'start' ? pos : far;
    const end = side === 'start' ? far : pos;
    if (end < start || end - start + 1 < minLen) return null;

    // Membership, not mere contact: a peptide clipping the edge is not what makes a cluster.
    const members = visible.filter((p) => inRegion(p, start, end, membership));
    return {
      start,
      end,
      anchoredOn: side,
      anchor: pos,
      anchorCount: family.length,
      farEdge: capped ? 'capped' : concentrated ? 'shared' : 'longest',
      farCount: capped || !concentrated ? 0 : modeCount,
      peptideCount: members.length,
      familySize: fitting.length,
      minIntensity: members.length ? Math.min(...members.map(peakOf)) : 0,
      maxIntensity: members.length ? Math.max(...members.map(peakOf)) : 0,
      parent: null,
    };
  };

  // --- anchors on both sides: a family may share its start and be ragged at the end, or the
  // other way round, and only looking at one side misses half of them ---
  const found: DetectedCluster[] = [];
  let sharedStarts = 0;
  let sharedEnds = 0;
  for (let pos = 1; pos <= seqLength; pos++) {
    if (isAnchor(pos, startCounts, startPrefix)) {
      sharedStarts++;
      const c = build(pos, 'start');
      if (c) found.push(c);
    }
    if (isAnchor(pos, endCounts, endPrefix)) {
      sharedEnds++;
      const c = build(pos, 'end');
      if (c) found.push(c);
    }
  }

  // Identical ranges can arise from a start anchor and an end anchor meeting in the middle;
  // keep the better-supported one.
  const unique = new Map<string, DetectedCluster>();
  for (const c of found) {
    const key = `${c.start}-${c.end}`;
    const prev = unique.get(key);
    if (!prev || c.anchorCount > prev.anchorCount) unique.set(key, c);
  }

  // Strongest first, so the survivor of any near-duplicate pair is the better-supported one.
  const ranked = [...unique.values()].sort(
    (a, b) =>
      b.anchorCount - a.anchorCount ||
      b.peptideCount - a.peptideCount ||
      b.end - b.start - (a.end - a.start) ||
      a.start - b.start,
  );

  // Two rules in one pass, working strongest first so the survivor is always the better
  // supported cluster rather than merely the longer or the first found:
  //
  //  - Nesting. A cluster wholly inside another is never reported beside it, whichever way
  //    round the containment runs and whether or not they share a terminus. Kept only when
  //    `hierarchical` is on, where the nesting is the point.
  //  - Near-duplicates. Partial overlap makes two clusters the same finding only when they
  //    are also of comparable length — that is what tells a duplicate box apart from a much
  //    shorter sub-cluster.
  const dropNested = !params.hierarchical;
  const kept: DetectedCluster[] = [];
  for (const c of ranked) {
    const own = c.end - c.start + 1;
    const redundant = kept.some((k) => {
      const overlap = Math.min(c.end, k.end) - Math.max(c.start, k.start) + 1;
      if (overlap <= 0) return false;
      if (dropNested) {
        const nested =
          (k.start <= c.start && k.end >= c.end) || (c.start <= k.start && c.end >= k.end);
        if (nested) return true;
      }
      const similarLength = own / (k.end - k.start + 1) >= share;
      return overlap / own >= share && similarLength;
    });
    if (!redundant) kept.push(c);
  }

  const ordered = kept.sort((a, b) => a.start - b.start || a.end - b.end);

  // --- derived sub-clusters (hierarchical mode only — nothing is nested otherwise) ---
  const parentOf = (i: number): number | null => {
    const c = ordered[i];
    let best: number | null = null;
    for (let j = 0; j < ordered.length; j++) {
      if (j === i) continue;
      const d = ordered[j];
      const contains = d.start <= c.start && d.end >= c.end;
      const bigger = d.end - d.start > c.end - c.start;
      if (!contains || !bigger) continue;
      // Nearest enclosing parent, so a chain reads parent -> child -> grandchild.
      if (best === null || ordered[j].end - ordered[j].start < ordered[best].end - ordered[best].start) {
        best = j;
      }
    }
    return best;
  };

  const parents = ordered.map((_, i) => parentOf(i));

  if (!params.hierarchical) {
    const clusters = ordered.filter((_, i) => parents[i] === null);
    return { clusters, sharedStarts, sharedEnds };
  }

  // Hierarchical: keep everything, but renumber parent links against the returned array.
  const clusters = ordered.map((c, i) => ({ ...c, parent: parents[i] }));
  return { clusters, sharedStarts, sharedEnds };
}
