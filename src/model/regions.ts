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
