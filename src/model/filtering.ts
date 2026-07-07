// Peptide filtering and removed-peptide reporting.
// Ports the filtering logic from plot_protein_coverage_with_time_layers (main.py:663-758)
// and identify_removed_peptides (main.py:247-373), keeping behaviour time-point specific.

import { Config, Transformation } from '../state/config';
import { intensityBins } from './intensity';
import { Peptide, peptideSequence } from './peptides';
import { transformValue } from './intensity';

export interface IntensityScale {
  /** Original (untransformed) thresholds actually used. */
  minRaw: number;
  maxRaw: number;
  /** Transformed thresholds (used for binning + comparisons). */
  minT: number;
  maxT: number;
  /** Bin edges across [minT, maxT] for the configured colors. */
  bins: number[];
  transformation: Transformation;
  /** Whether thresholds were user-supplied (vs derived from data). */
  minUserSet: boolean;
  maxUserSet: boolean;
}

/**
 * Compute the intensity scale from the FULL dataset so colors stay consistent across
 * all split figures (mirrors the intent of generate_split_figures, main.py:986-1019).
 */
export function computeIntensityScale(
  peptides: Peptide[],
  columns: string[],
  config: Config,
): IntensityScale {
  const { transformation, minPeptideLength, maxPeptideLength } = config;
  const nColors = config.colors.length;

  const minUserSet = config.minIntensity != null;
  const maxUserSet = config.maxIntensity != null;

  let minRaw = config.minIntensity;
  let maxRaw = config.maxIntensity;

  if (minRaw == null || maxRaw == null) {
    const values: number[] = [];
    for (const p of peptides) {
      const len = p.end - p.start + 1;
      if (len < minPeptideLength) continue;
      if (maxPeptideLength != null && len > maxPeptideLength) continue;
      for (const col of columns) {
        const v = p.intensity[col] ?? 0;
        if (v > 0) values.push(v);
      }
    }
    if (values.length) {
      if (maxRaw == null) maxRaw = Math.max(...values);
      if (minRaw == null) minRaw = Math.min(...values);
    } else {
      if (maxRaw == null) maxRaw = 1;
      if (minRaw == null) minRaw = 1;
    }
  }

  const minT = transformValue(minRaw, transformation);
  const maxT = transformValue(maxRaw, transformation);

  return {
    minRaw,
    maxRaw,
    minT,
    maxT,
    bins: intensityBins(minT, maxT, nColors),
    transformation,
    minUserSet,
    maxUserSet,
  };
}

/** True if a peptide should be drawn at a given time point under the active filters. */
export function passesFilters(
  p: Peptide,
  col: string,
  config: Config,
  scale: IntensityScale,
): boolean {
  const v = p.intensity[col] ?? 0;
  if (v <= 0) return false;

  const len = p.end - p.start + 1;
  if (len < config.minPeptideLength) return false;
  if (config.maxPeptideLength != null && len > config.maxPeptideLength) return false;

  const tv = transformValue(v, config.transformation);
  if (scale.minUserSet && tv < scale.minT) return false;
  if (scale.maxUserSet && tv > scale.maxT) return false;
  return true;
}

/** Unique peptide IDs displayed at >=1 time point (for the filtering summary). */
export function displayedPeptideIds(
  peptides: Peptide[],
  columns: string[],
  config: Config,
  scale: IntensityScale,
): Set<string> {
  const ids = new Set<string>();
  for (const col of columns) {
    for (const p of peptides) {
      if (passesFilters(p, col, config, scale)) ids.add(`${p.start}-${p.end}`);
    }
  }
  return ids;
}

export interface TimepointRemoval {
  col: string;
  timeLabel: string;
  reasons: string[];
  intensity: number;
}

export interface RemovedPeptide {
  start: number;
  end: number;
  length: number;
  sequence: string;
  summaryReasons: string[];
  byTimepoint: TimepointRemoval[];
  intensity: Record<string, number>;
}

/**
 * Identify peptides removed by length or intensity filters, per time point.
 * Ports identify_removed_peptides (main.py:247-373).
 */
export function identifyRemovedPeptides(
  peptides: Peptide[],
  proteinSeq: string,
  columns: string[],
  config: Config,
  scale: IntensityScale,
): RemovedPeptide[] {
  const { minPeptideLength, maxPeptideLength, transformation, minIntensity, maxIntensity } = config;
  const removed: RemovedPeptide[] = [];

  for (const p of peptides) {
    const length = p.end - p.start + 1;
    const tooShort = length < minPeptideLength;
    const tooLong = maxPeptideLength != null && length > maxPeptideLength;

    const byTimepoint: TimepointRemoval[] = [];

    for (const col of columns) {
      const v = p.intensity[col] ?? 0;
      if (v <= 0) continue; // zero intensities are never shown anyway

      const reasons: string[] = [];
      if (tooShort) reasons.push(`Too short (length: ${length} < min: ${minPeptideLength})`);
      if (tooLong) reasons.push(`Too long (length: ${length} > max: ${maxPeptideLength})`);

      if (scale.minUserSet || scale.maxUserSet) {
        const tv = transformValue(v, transformation);
        if (scale.minUserSet && tv < scale.minT) {
          reasons.push(
            `Below min intensity (min: ${fmt(minIntensity)}, intensity: ${v.toExponential(2)})`,
          );
        } else if (scale.maxUserSet && tv > scale.maxT) {
          reasons.push(
            `Above max intensity (max: ${fmt(maxIntensity)}, intensity: ${v.toExponential(2)})`,
          );
        }
      }

      if (reasons.length) {
        byTimepoint.push({
          col,
          timeLabel: config.timeLabels[col] ?? col,
          reasons,
          intensity: v,
        });
      }
    }

    if (byTimepoint.length || tooShort || tooLong) {
      const summaryReasons: string[] = [];
      if (tooShort) summaryReasons.push(`Too short (length: ${length} < min: ${minPeptideLength})`);
      if (tooLong) summaryReasons.push(`Too long (length: ${length} > max: ${maxPeptideLength})`);
      for (const tp of byTimepoint) {
        for (const r of tp.reasons) {
          if (r.toLowerCase().includes('intensity')) summaryReasons.push(`${tp.timeLabel}: ${r}`);
        }
      }

      const intensity: Record<string, number> = {};
      for (const col of columns) intensity[col] = p.intensity[col] ?? 0;

      removed.push({
        start: p.start,
        end: p.end,
        length,
        sequence:
          proteinSeq && p.start <= proteinSeq.length && p.end <= proteinSeq.length
            ? peptideSequence(proteinSeq, p.start, p.end)
            : '',
        summaryReasons,
        byTimepoint,
        intensity,
      });
    }
  }

  return removed;
}

function fmt(n?: number): string {
  return n == null ? 'None' : n.toExponential(2);
}
