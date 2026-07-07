// The layout engine: the piece that did not exist in the Matplotlib version.
// Splits on both axes (time-point groups -> figures; sequence ranges -> panels),
// wraps long sequences into rows of N residues, and computes page-break positions.
//
// Vertical row packing is GLOBAL per figure+time-point: each peptide keeps the same
// row index across every wrap-row/panel it touches, so a peptide crossing a wrap or
// split boundary stays visually continuous (and bottom-aligned) between pieces.

import { Config, Range } from '../state/config';
import { colorIndex, transformValue } from './intensity';
import { IntensityScale, computeIntensityScale, passesFilters } from './filtering';
import { Peptide, assignRows, peptideId } from './peptides';

/** A peptide clipped to a wrap-row window, with its resolved color bin and global row. */
export interface ClippedPeptide {
  start: number; // clipped, 1-based inclusive
  end: number; // clipped, 1-based inclusive
  fullStart: number; // original peptide start (for modification mapping)
  colorIdx: number;
  id: string;
  rowIndex: number; // stable global row within this band
}

/** One time-point band within a wrap-row. `rowCount` is constant across all windows. */
export interface BandLayout {
  col: string;
  label: string;
  rowCount: number;
  cells: ClippedPeptide[];
}

/** One wrapped block covering residues [startRes, endRes] (1-based inclusive). */
export interface WrapRowLayout {
  startRes: number;
  endRes: number;
  panelStart: boolean;
  bands: BandLayout[];
  heightUnits: number;
}

/** A band (time point) on a page, possibly only a contiguous slice of its peptide rows
 *  when the band is taller than one page and continues onto the next. */
export interface BandSlice {
  band: BandLayout;
  /** Peptide-row range [rowStart, rowEnd) of the band drawn on this page. */
  rowStart: number;
  rowEnd: number;
  /** True when rowEnd reaches the band's last row, i.e. the band finishes here. */
  bandComplete: boolean;
}

/** One wrap-row's content on a page: its ruler/sequence header plus the band slices
 *  shown beneath it. A wrap-row whose bands overflow a page appears on several pages,
 *  each re-drawing the header (so the residue ruler/sequence sits above every page). */
export interface WrapRowSlice {
  row: WrapRowLayout;
  bands: BandSlice[];
  /** True when this is a continued portion of a wrap-row from the previous page (its
   *  header is repeated for context, and the inter-panel gap is suppressed). */
  continued: boolean;
}

/** One vertical column on a page: its wrap-row slices stacked from the top, offset
 *  horizontally by `xOffset` (pt). A normal page is a single column at xOffset 0; a
 *  narrow segment laid out in newspaper columns has several side by side. */
export interface PageColumn {
  xOffset: number;
  wrapRows: WrapRowSlice[];
}

/** Everything drawn on one printed/exported page, sized to fit the page height. */
export interface PageContent {
  columns: PageColumn[];
}

export interface FigureLayout {
  title: string;
  columns: string[];
  scale: IntensityScale;
  rows: WrapRowLayout[];
  pages: PageContent[];
}

export interface LayoutResult {
  figures: FigureLayout[];
}

const RULER_UNITS = 1.6;
const RESIDUE_ROW_UNITS = 1;
const BAND_GAP_UNITS = 1;
const PANEL_GAP_UNITS = 1.5;

const PAGE_MM: Record<'A4' | 'Letter', [number, number]> = {
  A4: [210, 297],
  Letter: [215.9, 279.4],
};

const TITLE_UNITS = 3;
export const LEGEND_UNITS = 4;

/** 1 point = 1/72 inch; 1 inch = 25.4 mm. SVG output declares physical size in points
 *  (see PrimSvg) so this is the single conversion used everywhere page math meets print. */
export const PT_PER_MM = 72 / 25.4;

/**
 * Cell width/height in pt — the single source of truth for on-paper cell geometry.
 * A character's cap height is ≈70% of its font size, so the cell only needs to be a bit
 * larger than the letter. `cellScale` (× residue font) controls how tightly the squares
 * hug the letters: the 1.1 default leaves ~7% padding per side, while smaller values pack
 * residues closer together to fit more data per page (letters stay visible down to ~0.8).
 * A small absolute floor keeps cells from collapsing at tiny font sizes.
 */
export function cellSize(config: Config): number {
  return Math.max(4, Math.round(config.fontSizes.residue * (config.cellScale ?? 1.1)));
}

/**
 * Width (in pt) reserved for the left time-point-label column ("0.5h", "1h", ...).
 * Sized to the longest configured label text — not a fixed character count — so short
 * labels don't reserve far more room than they need and leave a wide empty margin
 * before the ruler/sequence begins. (~0.6 * font size per character, like legend labels.)
 */
export function leftLabelWidth(config: Config): number {
  const cell = cellSize(config);
  const labels = config.intensityCols.map((c) => config.timeLabels[c] ?? c);
  const maxLen = labels.reduce((m, l) => Math.max(m, l.length), 0);
  const textWidth = Math.ceil(maxLen * config.fontSizes.timeLabel * 0.6);
  return Math.max(cell * 1.5, textWidth + 12);
}

/** Resolve the physical page size in points as [width, height], honoring orientation
 *  and custom dimensions — the canonical page-geometry helper for print/export math. */
export function pageDimsPt(config: Config): [number, number] {
  const [wMm, hMm] =
    config.page.size === 'custom'
      ? [config.page.customWidthMm, config.page.customHeightMm]
      : PAGE_MM[config.page.size];
  let w = wMm * PT_PER_MM;
  let h = hMm * PT_PER_MM;
  if (config.page.orientation === 'landscape' && w < h) [w, h] = [h, w];
  if (config.page.orientation === 'portrait' && w > h) [w, h] = [h, w];
  return [w, h];
}

/**
 * Residues-per-row that exactly fill the printable page width at the configured font
 * size, so a printed/exported page renders the chosen point size 1:1 — no browser
 * rescaling needed to make it fit. This is the "horizontal" half of `autoSizeToPage`.
 */
export function autoResiduesPerRow(config: Config): number {
  const cell = cellSize(config);
  const [wPt] = pageDimsPt(config);
  const printableWPt = wPt - 2 * config.page.margins * PT_PER_MM - leftLabelWidth(config);
  return Math.max(1, Math.floor(printableWPt / cell));
}

/** Vertical gap (pt) between adjacent peptide lines in 'line' style — just enough to
 *  keep stacked lines visually separable without a full letter-box's worth of room. */
const LINE_ROW_GAP_PT = 3;

/**
 * Vertical space (pt) allocated per peptide row within a band. Box style needs a full
 * cell so the residue letter fits; line style only needs the stroke plus a small gap,
 * which is what lets it pack substantially more overlapping peptides into the same
 * height — directly answering "show more data" in the same figure.
 */
export function rowPitch(config: Config): number {
  return config.peptideStyle === 'line' ? config.lineThickness + LINE_ROW_GAP_PT : cellSize(config);
}

function clampRange(seqLen: number, r: Range): Range {
  return [Math.max(1, Math.min(r[0], r[1])), Math.min(seqLen, Math.max(r[0], r[1]))];
}

/** Extract the leading numeric time value from a label/column (e.g. "0.5h" -> 0.5). */
function extractTimeNumber(s: string): number {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : Number.POSITIVE_INFINITY; // unparseable sort last
}

function buildWindows(seqLen: number, config: Config, residuesPerRow: number): Array<{
  startRes: number;
  endRes: number;
  panelStart: boolean;
}> {
  const splits: Range[] =
    config.sequenceSplits.length > 0
      ? config.sequenceSplits.map((r) => clampRange(seqLen, r))
      : [[1, seqLen]];

  const breaks = new Set(config.page.manualBreaks.filter((b) => b > 1 && b <= seqLen));
  const windows: Array<{ startRes: number; endRes: number; panelStart: boolean }> = [];

  for (const [splitStart, splitEnd] of splits) {
    let pos = splitStart;
    let first = true;
    while (pos <= splitEnd) {
      let end = Math.min(pos + residuesPerRow - 1, splitEnd);
      for (let b = pos + 1; b <= end; b++) {
        if (breaks.has(b)) {
          end = b - 1;
          break;
        }
      }
      windows.push({ startRes: pos, endRes: end, panelStart: first });
      pos = end + 1;
      first = false;
    }
  }
  return windows;
}

interface GlobalPacking {
  /** Columns that have at least one passing peptide, in visual (reversed) order. */
  validCols: string[];
  /** col -> (peptideId -> global row index). */
  rowOf: Record<string, Map<string, number>>;
  /** col -> number of rows (>= 1). */
  rowCount: Record<string, number>;
}

/** Pack each time-point's peptides into rows ONCE, over the whole sequence. */
function packFigure(
  peptides: Peptide[],
  columns: string[],
  config: Config,
  scale: IntensityScale,
): GlobalPacking {
  // Order time points incrementally by their numeric value (0h -> 72h), top to bottom.
  const ordered = [...columns].sort(
    (a, b) =>
      extractTimeNumber(config.timeLabels[a] ?? a) - extractTimeNumber(config.timeLabels[b] ?? b),
  );
  const rowOf: Record<string, Map<string, number>> = {};
  const rowCount: Record<string, number> = {};
  const validCols: string[] = [];

  for (const col of ordered) {
    const passing = peptides.filter((p) => passesFilters(p, col, config, scale));
    if (passing.length === 0) continue; // drop empty columns (matches valid_time_intervals)
    validCols.push(col);
    // Original sort (start asc, end desc): groups peptides by start position so every
    // cluster of peptides sharing the same left edge lands in consecutive rows. Combined
    // with top-down rendering (row 0 = top), this produces the clean icicle staircase.
    const rows = assignRows(passing);
    const map = new Map<string, number>();
    rows.forEach((row, ri) => row.forEach((p) => map.set(peptideId(p), ri)));
    rowOf[col] = map;
    rowCount[col] = Math.max(1, rows.length);
  }
  return { validCols, rowOf, rowCount };
}

function buildBands(
  windowStart: number,
  windowEnd: number,
  peptides: Peptide[],
  config: Config,
  scale: IntensityScale,
  packing: GlobalPacking,
): BandLayout[] {
  return packing.validCols.map((col) => {
    const cells: ClippedPeptide[] = [];
    for (const p of peptides) {
      if (!passesFilters(p, col, config, scale)) continue;
      if (p.end < windowStart || p.start > windowEnd) continue;
      const v = p.intensity[col] ?? 0;
      const tv = transformValue(v, config.transformation);
      const id = peptideId(p);
      cells.push({
        start: Math.max(p.start, windowStart),
        end: Math.min(p.end, windowEnd),
        fullStart: p.start,
        colorIdx: colorIndex(tv, scale.bins, config.colors.length),
        id,
        rowIndex: packing.rowOf[col].get(id) ?? 0,
      });
    }
    return { col, label: config.timeLabels[col] ?? col, rowCount: packing.rowCount[col], cells };
  });
}

// Heights are tracked in "cell units" (1 unit == 1 cell, in pt — see cellSize/pageDimsPt)
// throughout pagination math. Peptide rows, however, may use a different pitch (line
// style is more compact), so their contribution is expressed as a fraction of a cell.
function wrapRowHeight(bands: BandLayout[], panelStart: boolean, config: Config): number {
  const pitchUnits = rowPitch(config) / cellSize(config);
  let h = RULER_UNITS + RESIDUE_ROW_UNITS;
  for (const band of bands) h += band.rowCount * pitchUnits + BAND_GAP_UNITS;
  if (panelStart) h += PANEL_GAP_UNITS;
  return h;
}

/**
 * Paginate a figure's wrap-rows into printed pages, filling each page to the available
 * height. Unlike a coarse row- or band-level split, this packs at peptide-row
 * granularity: a single time-point band taller than one page is broken at a clean row
 * boundary (never mid-cell) and continues on the next page, where the ruler/sequence
 * header is re-drawn for context. This keeps the figure visually continuous and uses
 * every inch of the page — important for publication figures.
 */
/** Greedily pack one wrap-row's bands into vertical strips that each fit `colHeightUnits`,
 *  splitting a band taller than the budget at a clean row boundary. Each strip re-draws
 *  the ruler/sequence header. Used to lay a narrow segment out in newspaper columns. */
function packWindowStrips(
  row: WrapRowLayout,
  colHeightUnits: number,
  headerUnits: number,
  pitchUnits: number,
): WrapRowSlice[] {
  const strips: WrapRowSlice[] = [];
  let bi = 0;
  let pr = 0;
  while (bi < row.bands.length) {
    let used = headerUnits;
    const sliceBands: BandSlice[] = [];
    let full = false;
    while (bi < row.bands.length && !full) {
      const band = row.bands[bi];
      let canFit = Math.floor((colHeightUnits - used) / pitchUnits);
      if (canFit <= 0 && sliceBands.length === 0) canFit = 1; // tiny column: force progress
      if (canFit <= 0) {
        full = true;
        break;
      }
      const take = Math.min(canFit, band.rowCount - pr);
      const rowEnd = pr + take;
      const bandComplete = rowEnd >= band.rowCount;
      sliceBands.push({ band, rowStart: pr, rowEnd, bandComplete });
      used += take * pitchUnits;
      if (bandComplete) {
        used += BAND_GAP_UNITS;
        bi++;
        pr = 0;
      } else {
        pr = rowEnd;
        full = true;
      }
    }
    strips.push({ row, bands: sliceBands, continued: false });
  }
  return strips;
}

/** How many side-by-side columns of `row` fit across the printable page width, and the
 *  horizontal pitch (pt) between successive columns' left edges. Each column reserves room
 *  for its own time-point labels (leftLabelWidth) plus the residue chart and a gutter. */
function columnsForWindow(row: WrapRowLayout, config: Config): { count: number; pitch: number } {
  const cell = cellSize(config);
  const leftLabel = leftLabelWidth(config);
  const chartW = (row.endRes - row.startRes + 1) * cell;
  const gutter = cell; // breathing room between one column's chart and the next's labels
  const pitch = leftLabel + chartW + gutter;
  const [wPt] = pageDimsPt(config);
  const printableWPt = wPt - 2 * config.page.margins * PT_PER_MM;
  // Column i's chart starts at leftLabel + i*pitch and is chartW wide; require the last
  // column's right edge to stay within the printable width.
  const count = Math.max(1, Math.floor((printableWPt - leftLabel - chartW) / pitch) + 1);
  return { count, pitch };
}

function computePages(rows: WrapRowLayout[], config: Config, seqLen: number): PageContent[] {
  const oneColumn = (wrapRows: WrapRowSlice[]): PageContent => ({ columns: [{ xOffset: 0, wrapRows }] });
  if (rows.length === 0) return [oneColumn([])];
  const breaks = new Set(config.page.manualBreaks.filter((b) => b > 1 && b <= seqLen));

  const wholeRow = (row: WrapRowLayout, continued = false): WrapRowSlice => ({
    row,
    continued,
    bands: row.bands.map((band) => ({ band, rowStart: 0, rowEnd: band.rowCount, bandComplete: true })),
  });

  // `autoSizeToPage` always fits pages to the printable height (rows vary in height
  // depending on how many time-point bands they carry, so a fixed row count can't
  // guarantee a 1:1 fit — height-based packing is what actually fills each page).
  const useHeightFit = config.page.autoSizeToPage || config.page.rowsPerPage === 'auto';

  // Fixed rows-per-page mode keeps whole wrap-rows together, N per page (legacy behavior
  // for users who set an explicit row count rather than auto-fitting to the page).
  if (!useHeightFit) {
    const per = Math.max(1, config.page.rowsPerPage as number);
    const pages: PageContent[] = [];
    let cur: WrapRowSlice[] = [];
    for (let i = 0; i < rows.length; i++) {
      const forced = i > 0 && breaks.has(rows[i].startRes);
      if (i > 0 && (forced || cur.length >= per)) {
        pages.push(oneColumn(cur));
        cur = [];
      }
      cur.push(wholeRow(rows[i]));
    }
    pages.push(oneColumn(cur));
    return pages;
  }

  // Work entirely in points — the same unit the SVG declares physically (1 user unit
  // == 1 pt) — so `unitsPerPage` matches the real on-paper cell size exactly.
  const cell = cellSize(config);
  const [, hPt] = pageDimsPt(config);
  const printableHPt = Math.max(cell, hPt - 2 * config.page.margins * PT_PER_MM);
  // drawPage adds one cell of bottom padding (its rendered height is `y + cell`). If the
  // budget were the full printable height, a page could render ~one cell taller than the
  // sheet, and the browser's print engine — unable to honor `break-inside: avoid` on an
  // oversized element — would slice it, cutting a peptide row. Reserve that padding cell
  // plus a sliver for pt→px rounding so every page fits the sheet and breaks land between
  // rows, never through them.
  const PAGE_HEIGHT_SLACK = 1.25; // cells: 1 for bottom padding, 0.25 for rounding
  const unitsPerPage = Math.max(1, printableHPt / cell - PAGE_HEIGHT_SLACK);
  const pitchUnits = rowPitch(config) / cell;
  const headerUnits = RULER_UNITS + RESIDUE_ROW_UNITS;

  const pages: PageContent[] = [];
  let pageRows: WrapRowSlice[] = [];
  let used = TITLE_UNITS; // the title occupies the top of the very first page only

  const flushPage = () => {
    pages.push(oneColumn(pageRows));
    pageRows = [];
    used = 0;
  };

  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    if (ri > 0 && breaks.has(row.startRes) && pageRows.length > 0) flushPage();

    // Newspaper-column layout for a narrow segment: when enabled and two or more columns
    // fit across the page, lay this window's stacked bands into side-by-side full-height
    // columns instead of one tall, mostly-empty strip down many pages.
    const colLayout = config.packNarrowSegments ? columnsForWindow(row, config) : null;
    if (colLayout && colLayout.count >= 2) {
      if (pageRows.length > 0) flushPage(); // start the columned window on a fresh page
      const titleOnFirst = pages.length === 0; // window is the figure's first content
      const colHeightUnits = Math.max(1, unitsPerPage - (titleOnFirst ? TITLE_UNITS : 0));
      const strips = packWindowStrips(row, colHeightUnits, headerUnits, pitchUnits);
      for (let s = 0; s < strips.length; s += colLayout.count) {
        const group = strips.slice(s, s + colLayout.count);
        pages.push({ columns: group.map((strip, k) => ({ xOffset: k * colLayout.pitch, wrapRows: [strip] })) });
      }
      used = 0; // any following window starts on a fresh vertical page
      continue;
    }

    const panelGap = row.panelStart && ri > 0 ? PANEL_GAP_UNITS : 0;
    let bi = 0; // current band
    let pr = 0; // next peptide row within band bi
    let firstAppearance = true; // first page this wrap-row appears on

    while (bi < row.bands.length) {
      const gap = firstAppearance ? panelGap : 0;
      // Start this wrap-row (or its continuation) on a page that can hold the header plus
      // at least one peptide row; otherwise move to a fresh page first.
      if (pageRows.length > 0 && used + gap + headerUnits + pitchUnits > unitsPerPage) {
        flushPage();
      }
      used += (pageRows.length === 0 ? 0 : gap) + headerUnits;

      const sliceBands: BandSlice[] = [];
      let pageFull = false;
      while (bi < row.bands.length && !pageFull) {
        const band = row.bands[bi];
        let canFit = Math.floor((unitsPerPage - used) / pitchUnits);
        // Pathological tiny page: header alone fills it. Force one row so we progress.
        if (canFit <= 0 && sliceBands.length === 0 && pageRows.length === 0) canFit = 1;
        if (canFit <= 0) {
          pageFull = true;
          break;
        }
        const take = Math.min(canFit, band.rowCount - pr);
        const rowEnd = pr + take;
        const bandComplete = rowEnd >= band.rowCount;
        sliceBands.push({ band, rowStart: pr, rowEnd, bandComplete });
        used += take * pitchUnits;
        if (bandComplete) {
          used += BAND_GAP_UNITS;
          bi++;
          pr = 0;
        } else {
          pr = rowEnd;
          pageFull = true; // band didn't finish -> page is full
        }
      }

      pageRows.push({ row, bands: sliceBands, continued: !firstAppearance });
      firstAppearance = false;
      if (pageFull && bi < row.bands.length) flushPage(); // more of this wrap-row remains
    }
  }
  if (pageRows.length > 0 || pages.length === 0) flushPage();
  return pages;
}

export function buildLayout(
  proteinSeq: string,
  peptides: Peptide[],
  config: Config,
  residuesPerRowOverride?: number,
): LayoutResult {
  const seqLen = proteinSeq.length;
  const allCols = config.intensityCols;

  const groups: string[][] =
    config.timeGroups.length > 0 ? config.timeGroups.filter((g) => g.length > 0) : [allCols];

  const residuesPerRow = Math.max(1, residuesPerRowOverride ?? config.page.residuesPerRow);

  // One scale from the FULL dataset (all selected columns) so the same peptide keeps the
  // same color across every split figure (matches the original generate_split_figures intent).
  const scale = computeIntensityScale(peptides, allCols, config);

  const figures: FigureLayout[] = groups.map((group, gi) => {
    const packing = packFigure(peptides, group, config, scale);
    const windows = buildWindows(seqLen, config, residuesPerRow);

    const rows: WrapRowLayout[] = windows.map((w) => {
      const bands = buildBands(w.startRes, w.endRes, peptides, config, scale, packing);
      return {
        startRes: w.startRes,
        endRes: w.endRes,
        panelStart: w.panelStart,
        bands,
        heightUnits: wrapRowHeight(bands, w.panelStart, config),
      };
    });

    const title =
      groups.length > 1 && config.appendFigureNumbers
        ? `${config.titleText} — Figure ${gi + 1}`
        : config.titleText;

    return { title, columns: packing.validCols, scale, rows, pages: computePages(rows, config, seqLen) };
  });

  return { figures };
}
