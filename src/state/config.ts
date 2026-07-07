// Central configuration model and defaults.
// Ports get_default_settings() and title/filename helpers from the original main.py.

export type Transformation = 'none' | 'log2' | 'log10';
export type Notation = 'superscript' | 'exponential' | 'integer' | 'float';
export type PageSize = 'A4' | 'Letter' | 'custom';
export type Orientation = 'portrait' | 'landscape';
/** How peptides are drawn: filled letter-boxes, or compact colored lines (fits more data). */
export type PeptideStyle = 'box' | 'line';
/** Which legend style to render. */
export type LegendStyle = 'bar' | 'list';
/** Labels shown at the top/bottom of the gradient bar legend. */
export type LegendBarLabels = 'highlow' | 'numbers';

/** One amino-acid range, 1-based inclusive: [start, end]. */
export type Range = [number, number];

export interface FontSizes {
  title: number;
  tick: number;
  residue: number;
  timeLabel: number;
  legendTitle: number;
  legendLabel: number;
}

export interface PageSetup {
  size: PageSize;
  orientation: Orientation;
  /** Residues per wrapped row. When `autoFitWidth` is on this is derived from container width. */
  residuesPerRow: number;
  /** Wrap-rows per printed page, or 'auto' to fit the printable page height. */
  rowsPerPage: number | 'auto';
  /** Explicit 1-based residue positions that force a page break before them ("punto"). */
  manualBreaks: number[];
  /** Page margin in millimetres. */
  margins: number;
  /** Custom page size in mm (used when size === 'custom'). */
  customWidthMm: number;
  customHeightMm: number;
  /**
   * When true, `residuesPerRow` and `rowsPerPage` are computed from the physical page
   * size/orientation/margins and the configured font size, so a printed/exported page is
   * filled edge-to-edge with the chosen point size rendered at 1:1 (no browser rescaling).
   * Overrides the manual `residuesPerRow`/`rowsPerPage` fields for print/export output.
   */
  autoSizeToPage: boolean;
}

export interface Config {
  // --- data mapping ---
  startCol: string;
  endCol: string;
  intensityCols: string[];
  peptideSeqCol?: string;
  /** Display label override per intensity column. */
  timeLabels: Record<string, string>;

  // --- intensity ---
  transformation: Transformation;
  minIntensity?: number;
  maxIntensity?: number;
  /** N-level color ramp (low -> high). Any length >= 2. */
  colors: string[];
  notation: Notation;
  legendTitle: string;
  /** Which legend style to render in the lower-right corner of the chart. */
  legendStyle: LegendStyle;
  /** For the 'bar' style: label the top/bottom with "High"/"Low" or the actual intensity values. */
  legendBarLabels: LegendBarLabels;
  /** When true, draw the legend on every page instead of only the last one. */
  legendOnEveryPage: boolean;
  /**
   * Manual offset (px) from each legend's default lower-right anchor, e.g. from dragging
   * it. Keyed by page id ("fig{N}_page{M}", matching data-export-id) so a figure that
   * splits into several pages/figures — each with its own legend — can have every legend
   * positioned independently.
   */
  legendOffsets: Record<string, { x: number; y: number }>;
  /**
   * Manual size multiplier for each legend (1 = default), keyed by page id like
   * `legendOffsets`. Set by dragging the legend's resize handle; scales the whole legend
   * (title, swatches, labels) uniformly about its fixed bottom-right anchor.
   */
  legendScales: Record<string, number>;

  // --- filtering ---
  minPeptideLength: number;
  maxPeptideLength?: number;

  // --- annotations ---
  highlightRegions: Range[];
  /** Stroke color for each highlight region rectangle, parallel to highlightRegions. */
  highlightColors: string[];
  /** peptideId ("start-end") -> 0-based positions within the peptide that are modified. */
  modifications: Record<string, number[]>;

  // --- peptide visualization ---
  /** Draw peptides as filled letter-boxes ('box', the original look) or as compact
   *  colored lines ('line') — lines pack many more overlapping peptides into the same
   *  vertical space since they don't need to fit a letter per residue. */
  peptideStyle: PeptideStyle;
  /** Stroke width (pt) for peptide lines when peptideStyle === 'line'. */
  lineThickness: number;
  /** Draw thin dashed vertical guide lines between residues, so a peptide line's start
   *  and end can be traced back to the reference sequence above it. */
  showResidueGridlines: boolean;

  // --- typography ---
  fontFamily: string;
  titleText: string;
  fontSizes: FontSizes;
  /**
   * Cell (square) size as a multiple of the residue font size. 1.1 is the default (~7%
   * padding around each letter); lower values pack residues tighter — smaller squares with
   * less gap between characters — to fit more data per page while the letters stay visible.
   */
  cellScale: number;

  // --- splitting (both axes) ---
  /** Vertical split: residue ranges -> stacked panels. Empty => whole sequence. */
  sequenceSplits: Range[];
  /** Horizontal split: column groups -> separate figures. Empty => one figure with all cols. */
  timeGroups: string[][];
  /** When true (default), append "— Figure N" to the title of each figure produced by a
   *  horizontal split. Uncheck to keep the raw title text on every figure. */
  appendFigureNumbers: boolean;

  // --- pagination / "punto" ---
  page: PageSetup;
  /**
   * When true, residuesPerRow for the on-screen (non-print) view is derived from the
   * container width — purely a viewing convenience. Print/export sizing is governed
   * separately by `page.autoSizeToPage`.
   */
  autoFitWidth: boolean;
  /**
   * When true, the on-screen view uses the print/export pagination (page.autoSizeToPage
   * or page.residuesPerRow) instead of the responsive width-derived layout — so pages,
   * page breaks, and per-page legends look exactly as they will when printed/exported,
   * letting each split legend be arranged in place beforehand.
   */
  printPreview: boolean;
  /**
   * When true, a narrow residue segment (e.g. the short leftover wrap panel at the end of
   * a long sequence) whose stacked time-point bands would otherwise run tall down many
   * mostly-empty pages is instead laid out in side-by-side "newspaper" columns that fill
   * the page width — each column repeating the ruler/sequence header. Only applies where
   * two or more columns actually fit across the page.
   */
  packNarrowSegments: boolean;

  // --- export ---
  pngDpi: number;
  addDatetimeToFilename: boolean;
}

export function defaultFontSizes(): FontSizes {
  return {
    title: 24,
    tick: 12,
    residue: 10,
    timeLabel: 12,
    legendTitle: 18,
    legendLabel: 16,
  };
}

export function defaultPageSetup(): PageSetup {
  return {
    size: 'A4',
    orientation: 'landscape',
    residuesPerRow: 60,
    rowsPerPage: 'auto',
    manualBreaks: [],
    margins: 10,
    customWidthMm: 297,
    customHeightMm: 210,
    autoSizeToPage: true,
  };
}

/** Ports get_default_settings() from main.py (lines 87-119), extended for the new model. */
export function defaultConfig(): Config {
  return {
    startCol: '',
    endCol: '',
    intensityCols: [],
    peptideSeqCol: undefined,
    timeLabels: {},

    transformation: 'none',
    minIntensity: undefined,
    maxIntensity: undefined,
    colors: ['#ffffcf', '#ffff00', '#ff7d00', '#ff0000', '#750000'],
    notation: 'superscript',
    legendTitle: 'Intensity Levels',
    legendStyle: 'bar',
    legendBarLabels: 'highlow',
    legendOnEveryPage: false,
    legendOffsets: {},
    legendScales: {},

    minPeptideLength: 1,
    maxPeptideLength: undefined,

    highlightRegions: [],
    highlightColors: [],
    modifications: {},

    peptideStyle: 'box',
    lineThickness: 2,
    showResidueGridlines: false,

    fontFamily: 'Trebuchet MS',
    titleText: 'Protein Peptide Visualization',
    fontSizes: defaultFontSizes(),
    cellScale: 1.1,

    sequenceSplits: [],
    timeGroups: [],
    appendFigureNumbers: true,

    page: defaultPageSetup(),
    autoFitWidth: true,
    printPreview: false,
    packNarrowSegments: false,

    pngDpi: 600,
    addDatetimeToFilename: false,
  };
}

/** Derive a title from a filename (drops extension), optionally appending a sheet name. */
export function deriveTitleFromFilename(
  filename: string | null | undefined,
  sheetName?: string | null,
  includeSheetName = true,
): string {
  if (!filename) return 'Protein Peptide Visualization';
  const stem = filename.replace(/\.[^./\\]+$/, '');
  if (includeSheetName && sheetName) return `${stem}_${sheetName}`;
  return stem;
}

/** Convert a title to a safe filename (ports sanitize_filename from main.py:137-153). */
export function sanitizeFilename(title: string | null | undefined): string {
  if (!title) return 'protein_peptide_visualization';
  let s = title.replace(/[^\w\s-]/g, '');
  s = s.replace(/\s+/g, '_');
  s = s.toLowerCase().replace(/^_+|_+$/g, '');
  return s || 'protein_peptide_visualization';
}

/** Timestamp suffix matching main.py's "%Y-%m-%d_%H-%M-%S". */
export function datetimeSuffix(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(
    d.getMinutes(),
  )}-${p(d.getSeconds())}`;
}
