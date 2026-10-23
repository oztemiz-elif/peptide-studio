// Intensity transforms, color binning, and number notation.
// Ports the numeric logic from main.py (lines 208-244, 691-711, 774, 886-896).

import { Notation, Transformation } from '../state/config';

export function transformValue(value: number, t: Transformation): number {
  if (value <= 0) return value;
  if (t === 'log2') return Math.log2(value);
  if (t === 'log10') return Math.log10(value);
  return value;
}

/** np.linspace(min, max, n+1) -> n+1 bin edges. */
export function linspace(min: number, max: number, count: number): number[] {
  if (count <= 1) return [min, max];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => min + step * i);
}

/**
 * Bin edges spanning [min,max] for `nColors` colors (nColors+1 edges).
 * min/max are the (already transformed) threshold range.
 */
export function intensityBins(min: number, max: number, nColors: number): number[] {
  return linspace(min, max, nColors + 1);
}

/**
 * Index of the color bin for a transformed intensity value.
 * Mirrors `min(np.digitize(intensity, bins) - 1, len(colors) - 1)` from main.py:774,
 * clamped into [0, nColors-1].
 */
export function colorIndex(transformedIntensity: number, bins: number[], nColors: number): number {
  // np.digitize: number of bin edges strictly <= value (right=False => edges[i-1] <= v < edges[i]).
  let d = 0;
  for (let i = 0; i < bins.length; i++) {
    if (transformedIntensity >= bins[i]) d = i + 1;
    else break;
  }
  return Math.max(0, Math.min(d - 1, nColors - 1));
}

// --- notation formatting (ports to_superscript / to_exponential_e / to_full_integer / to_float_notation) ---

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻',
};

// `digits` is the number of decimals kept. It defaults to 2 so the legend and every existing
// caller are unchanged; tables that need something terser pass 1.
export function toSuperscript(num: number, digits = 2): string {
  const [base, expStr] = num.toExponential(digits).split('e');
  const exp = parseInt(expStr, 10);
  const sup = String(exp)
    .split('')
    .map((ch) => SUPERSCRIPT[ch] ?? ch)
    .join('');
  return `${base} × 10${sup}`;
}

export function toExponentialE(num: number, digits = 2): string {
  return num.toExponential(digits).replace('e', 'E');
}

export function toFullInteger(num: number): string {
  return Math.trunc(num).toLocaleString('en-US');
}

export function toFloatNotation(num: number, digits = 2): string {
  return num.toFixed(digits);
}

export function formatNumber(num: number, notation: Notation, digits = 2): string {
  switch (notation) {
    case 'exponential':
      return toExponentialE(num, digits);
    case 'integer':
      return toFullInteger(num);
    case 'float':
      return toFloatNotation(num, digits);
    case 'superscript':
    default:
      return toSuperscript(num, digits);
  }
}

export function formatRange(start: number, end: number, notation: Notation): string {
  return `${formatNumber(start, notation)} - ${formatNumber(end, notation)}`;
}
