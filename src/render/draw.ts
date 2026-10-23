// Pure SVG primitive builder. Turns a figure/page of layout into geometry-only
// descriptors that the React components render. Keeping this pure makes it testable
// and reusable for PNG/SVG export. SVG user units == px; at natural (1:1) scale,
// a configured font size of N renders as N px, so print/export honor the chosen sizes.

import { Config } from '../state/config';
import {
  CENTER_BASELINE_RATIO,
  cellSize,
  FigureLayout,
  leftLabelWidth,
  BRACKET_LEG_PT,
  bracketLevels,
  BRACKET_ROW_PT,
  bracketUnits,
  REGION_FRAME_PAD_PT,
  regionFrameUnits,
  regionLabelUnits,
  residueRowUnits,
  rowPitch,
  WrapRowSlice,
} from '../model/layout';
import { formatRange } from '../model/intensity';
import { groupOverlappingRegions } from '../model/regions';

export type Prim =
  | {
      k: 'rect';
      x: number;
      y: number;
      w: number;
      h: number;
      fill?: string;
      stroke?: string;
      sw?: number;
      opacity?: number;
    }
  | {
      k: 'text';
      x: number;
      y: number;
      text: string;
      size: number;
      anchor: 'start' | 'middle' | 'end';
      weight?: string;
      fill?: string;
      family: string;
      /** When true, `y` is the visual centre of the text; PrimSvg converts this to an
       *  explicit baseline offset (Word ignores dominant-baseline — see PrimSvg). */
      center?: boolean;
    }
  | {
      k: 'line';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      stroke: string;
      sw: number;
      dash?: string;
      opacity?: number;
    };

export interface DrawnPage {
  width: number;
  height: number;
  prims: Prim[];
  /** Legend primitives, kept separate from `prims` so the UI can render them in their
   *  own draggable group without affecting the static chart underneath. */
  legend?: Prim[];
  /** Identifies this page's legend in Config.legendOffsets/legendScales, when set. */
  legendId?: string;
  /** Bounding box of the legend (after scaling) — used by the UI to place the resize
   *  handle and as the fixed bottom-right anchor for resize. */
  legendBox?: { x: number; y: number; w: number; h: number };
}

// Re-exported so PrimSvg, which turns the centring into a baseline, keeps one source for it.
export { CENTER_BASELINE_RATIO };

const RULER_UNITS = 1.6;
const BAND_GAP_UNITS = 1;
const PANEL_GAP_UNITS = 1.5;
const TITLE_UNITS = 3;
const PEPTIDE_ALPHA = 0.7;
/** Wash behind a sequence-row-only highlight region — a faint tint under the letters. */
const HIGHLIGHT_WASH_ALPHA = 0.12;
/**
 * Wash behind a "span all time points" region. Painted at the very back, under the peptide
 * cells, so it reads as a tinted band across every track rather than a veil over the data.
 * Peptides themselves are drawn at PEPTIDE_ALPHA (0.7), so ~30% of this wash still shows
 * through them and tints their intensity colour slightly — keep it faint for that reason.
 */
const SPAN_WASH_ALPHA = 0.2;

/** `#rgb` / `#rrggbb` to components; anything unparseable reads as black. */
function hexRgb(hex: string): [number, number, number] {
  const s = (hex ?? '').replace('#', '').trim();
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  if (full.length !== 6) return [0, 0, 0];
  const n = parseInt(full, 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [0, 0, 0];
}

/**
 * Ink for a letter sitting on `washes`, each `[hex, alpha]`, painted over the white page in
 * order. The letters are always drawn on top of the washes, so opacity alone never hides the
 * sequence — the only way to lose it is contrast, which is what this fixes: once the composite
 * is dark enough, the letter is drawn white instead of black.
 */
export function inkOnWashes(washes: [string, number][]): string {
  let r = 255;
  let g = 255;
  let b = 255;
  for (const [hex, alpha] of washes) {
    if (!(alpha > 0)) continue;
    const [cr, cg, cb] = hexRgb(hex);
    const a = Math.min(1, alpha);
    r += (cr - r) * a;
    g += (cg - g) * a;
    b += (cb - b) * a;
  }
  // Rec. 601 luma, which tracks perceived brightness closely enough for a two-way choice.
  return 0.299 * r + 0.587 * g + 0.114 * b < 140 ? '#ffffff' : '#000000';
}

export function pageCount(figure: FigureLayout): number {
  return Math.max(1, figure.pages.length);
}

function legendLabels(figure: FigureLayout, config: Config): string[] {
  const { bins } = figure.scale;
  const isInt = config.transformation === 'none';
  return config.colors.map((_, i) => {
    const lo = isInt ? Math.trunc(bins[i]) : bins[i];
    const hi = isInt ? Math.trunc(bins[i + 1]) : bins[i + 1];
    return formatRange(lo, hi, config.notation);
  });
}


/** Build all primitives for one page of a figure. `legendId` identifies this page's
 *  legend for independent drag positioning (see Config.legendOffsets); defaults to the
 *  page index when the caller doesn't supply one (e.g. tests). */
export function drawPage(
  figure: FigureLayout,
  pageIndex: number,
  proteinSeq: string,
  config: Config,
  legendId: string = String(pageIndex),
): DrawnPage {
  const cell = cellSize(config);
  const page = figure.pages[pageIndex] ?? { columns: [] };
  const columns = page.columns;
  const isFirst = pageIndex === 0;
  const isLast = pageIndex === pageCount(figure) - 1;

  const left = leftLabelWidth(config);
  const pitch = rowPitch(config);

  // Each column's right edge = (left + xOffset) + that column's widest panel. The page
  // spans the rightmost column.
  const colRight = (col: { xOffset: number; wrapRows: { row: { startRes: number; endRes: number } }[] }) =>
    col.wrapRows.reduce(
      (m, s) => Math.max(m, left + col.xOffset + (s.row.endRes - s.row.startRes + 1) * cell),
      left + col.xOffset,
    );
  const contentWidth = columns.reduce((m, col) => Math.max(m, colRight(col)), left);

  // Legend wraps onto multiple rows so it never overflows the page width.
  const labels = legendLabels(figure, config);

  const titleWidth = isFirst ? figure.title.length * config.fontSizes.title * 0.62 : 0;
  const width = Math.max(contentWidth, titleWidth);

  const prims: Prim[] = [];
  // The title spans the full page width; every column starts below it.
  let columnTop = 0;
  if (isFirst) {
    prims.push({
      k: 'text',
      x: width / 2,
      y: (TITLE_UNITS * cell) / 2,
      text: figure.title,
      size: config.fontSizes.title,
      anchor: 'middle',
      weight: 'bold',
      family: config.fontFamily,
      fill: '#000',
    });
    columnTop = TITLE_UNITS * cell;
  }

  const modSet = config.modifications;
  const bracketFlags = config.highlightBracket ?? [];
  const isBracket = new Set(
    config.highlightRegions.filter((_, i) => bracketFlags[i]).map((r) => `${r[0]}-${r[1]}`),
  );
  // Only the framed regions are grouped for the edge stagger — a bracketed one is annotated
  // above the sequence, so counting it here would push a neighbour's edges out for nothing.
  const highlightGroups = groupOverlappingRegions(
    config.highlightRegions.filter((_, i) => !bracketFlags[i]),
  );
  // Map "start-end" → chosen color so we can look up stroke color inside the row loop
  // even after groupOverlappingRegions reorders the regions.
  const highlightColorMap = new Map<string, string>(
    config.highlightRegions.map((r, i) => [
      `${r[0]}-${r[1]}`,
      (config.highlightColors ?? [])[i] ?? '#000000',
    ]),
  );
  // Same keying for the two other per-region settings: whether the box spans every
  // time-point band, and its optional caption.
  // Fill opacity per region. Unset falls back to the old fixed values so a figure made before
  // the control existed still looks the way it did.
  const highlightAlphaMap = new Map<string, number>(
    config.highlightRegions.map((r, i) => {
      const set = (config.highlightOpacity ?? [])[i];
      const span = (config.highlightSpanAll ?? [])[i] ?? false;
      const pct = set ?? (span ? SPAN_WASH_ALPHA : HIGHLIGHT_WASH_ALPHA) * 100;
      return [`${r[0]}-${r[1]}`, Math.min(100, Math.max(0, pct)) / 100];
    }),
  );
  const highlightSpanMap = new Map<string, boolean>(
    config.highlightRegions.map((r, i) => [
      `${r[0]}-${r[1]}`,
      (config.highlightSpanAll ?? [])[i] ?? false,
    ]),
  );
  const highlightLabelMap = new Map<string, string>(
    config.highlightRegions.map((r, i) => [
      `${r[0]}-${r[1]}`,
      ((config.highlightLabels ?? [])[i] ?? '').trim(),
    ]),
  );

  // Draw one wrap-panel slice at horizontal offset `colLeft`, starting at `startY`, and
  // return the y after it. Each panel is framed independently (its own left/right borders
  // and a solid bottom only where its table ends), so stacked panels read as separate
  // residue segments rather than one continuous vertical chart. `si` is the slice's index
  // within its column (0 = top of the column).
  function renderSlice(slice: WrapRowSlice, si: number, colLeft: number, startY: number): number {
    const { row, bands: bandSlices, continued } = slice;
    let y = startY;
    // Suppress the inter-panel gap for any slice at the top of its column (si === 0) and on
    // continued portions re-drawing the header; mirrors the pagination height accounting.
    if (!continued && row.panelStart && si !== 0) {
      y += PANEL_GAP_UNITS * cell;
    }
    /**
     * A marked region's edges: the two vertical rules at its first and last residue, and no
     * top or bottom. What a region asserts is where it begins and ends along the sequence —
     * a closed box also draws a horizontal rule across the letters' own row, which competes
     * with the sequence underline and buries a descender. The wash behind the letters already
     * shows the extent; these two lines say precisely where it stops.
     *
     * An edge falling at a wrap or panel boundary is suppressed. That edge is where the row
     * ran out, not where the region did, and a rule there would read as a boundary the data
     * never had — so a region continuing onto the next row simply carries no line at the join.
     */
    const regionEdges = (
      x: number,
      top: number,
      w: number,
      h: number,
      colour: string,
      drawStart: boolean,
      drawEnd: boolean,
    ) => {
      const edge = (ex: number) =>
        prims.push({ k: 'line', x1: ex, y1: top, x2: ex, y2: top + h, stroke: colour, sw: 1.5 });
      if (drawStart) edge(x);
      if (drawEnd) edge(x + w);
    };

    const panelFrameTop = y;
    const panelRight = colLeft + (row.endRes - row.startRes + 1) * cell;
    const lastBand = row.bands[row.bands.length - 1];
    let panelFrameBottom = y;
    let panelEnds = false;
    const x0 = (res: number) => colLeft + (res - row.startRes) * cell;

    // --- region captions, in their own row above the ruler ---
    // Reserving a row (rather than sharing the ruler's baseline and hiding whichever tick
    // numbers collided) keeps every residue position readable, which matters most exactly
    // where an annotation is drawing the eye. layout.ts reserves the same height, so
    // pagination and drawing stay in step.
    const labelBand = regionLabelUnits(config) * cell;
    const rulerY = y + labelBand + RULER_UNITS * cell;

    // How far the sequence sits below the ruler: the bracket band plus the headroom stacked
    // region frames need. A tick used to be a 2 pt nub resting on the letters; now that
    // annotations can push them apart, that nub would float halfway up with nothing joining a
    // number to the residue it names. So the tick reaches part of the way into the gap —
    // enough to point unmistakably at its residue, well short of closing the distance, which
    // would read as a gridline rather than a tick. With nothing annotated the gap is zero and
    // the tick is exactly the 2 pt it always was.
    const rulerGap = (bracketUnits(config) + regionFrameUnits(config)) * cell;
    const TICK_UP_PT = 2;
    const TICK_REACH = 0.5; // share of the gap the tick covers
    const TICK_MAX_PT = 5;
    const tickLen = Math.min(TICK_UP_PT + rulerGap * TICK_REACH, TICK_MAX_PT);

    const REGION_LABEL_GAP_PT = 3;
    const regionLabels: {
      x: number;
      text: string;
      anchor: 'start' | 'middle' | 'end';
      color: string;
      left: number;
      right: number;
    }[] = [];
    for (const [rs, re] of config.highlightRegions) {
      const text = highlightLabelMap.get(`${rs}-${re}`) ?? '';
      if (!text) continue;
      const s = Math.max(rs, row.startRes);
      const e = Math.min(re, row.endRes);
      if (s > e) continue; // region isn't visible in this panel
      const size = config.fontSizes.tick;
      const w = text.length * size * 0.62;
      const mid = (x0(s) + x0(e) + cell) / 2;
      // Keep a caption wider than its region inside the panel frame, mirroring the ticks.
      let anchor: 'start' | 'middle' | 'end' = 'middle';
      let labelX = mid;
      if (mid - w / 2 < colLeft) {
        anchor = 'start';
        labelX = colLeft + 2;
      } else if (mid + w / 2 > panelRight) {
        anchor = 'end';
        labelX = panelRight - 2;
      }
      const left = anchor === 'start' ? labelX : anchor === 'end' ? labelX - w : mid - w / 2;
      regionLabels.push({
        x: labelX,
        text,
        anchor,
        color: highlightColorMap.get(`${rs}-${re}`) ?? '#000000',
        left,
        right: left + w,
      });
    }
    // The forced label at the panel's first residue (e.g. "111") sits right next to the
    // next multiple-of-5 tick (e.g. "115") whenever the panel doesn't start on a multiple
    // of 5 — with tight cell packing there isn't always 4+ cells of room between them, so
    // the two labels collide. Track the previous label's drawn right edge (we draw in
    // increasing residue order, so labels are monotonic left-to-right) and skip any
    // subsequent tick whose label would overlap it, keeping the panel-start label intact.
    const TICK_LABEL_GAP_PT = 4;
    let prevLabelRight = -Infinity;
    for (let res = row.startRes; res <= row.endRes; res++) {
      if (res % 5 === 0 || res === row.startRes) {
        const text = String(res);
        const tickX = x0(res) + cell / 2;
        // A centered multi-digit label at a panel's first/last tick is wider than one cell
        // and would overflow the frame border; anchor it inward off that edge instead.
        const halfWidth = (text.length * config.fontSizes.tick) / 2;
        let anchor: 'start' | 'middle' | 'end' = 'middle';
        let labelX = tickX;
        if (tickX - halfWidth < colLeft) {
          anchor = 'start';
          labelX = colLeft + 2;
        } else if (tickX + halfWidth > panelRight) {
          anchor = 'end';
          labelX = panelRight - 2;
        }
        const labelWidth = halfWidth * 2;
        const labelLeft = anchor === 'start' ? labelX : anchor === 'end' ? labelX - labelWidth : labelX - halfWidth;
        const labelRight = labelLeft + labelWidth;
        if (res !== row.startRes && labelLeft < prevLabelRight + TICK_LABEL_GAP_PT) continue;
        prims.push({ k: 'text', x: labelX, y: rulerY - 4, text, size: config.fontSizes.tick, anchor, family: config.fontFamily, fill: '#333' });
        prevLabelRight = labelRight;
        prims.push({ k: 'line', x1: tickX, y1: rulerY - TICK_UP_PT, x2: tickX, y2: rulerY - TICK_UP_PT + tickLen, stroke: '#555', sw: 1 });
      }
    }
    // Captions sit on their own baseline just above the ruler. Overlapping regions can put
    // two captions on top of each other, so a later one that would collide with an already
    // drawn caption is skipped rather than printed as a smudge — shorten a label to get it
    // back, or turn off the neighbouring region's caption.
    let prevCaptionRight = -Infinity;
    const captionY = y + labelBand - 2;
    for (const rl of [...regionLabels].sort((a, b) => a.left - b.left)) {
      if (rl.left < prevCaptionRight + REGION_LABEL_GAP_PT) continue;
      prims.push({ k: 'text', x: rl.x, y: captionY, text: rl.text, size: config.fontSizes.tick, anchor: rl.anchor, weight: 'bold', family: config.fontFamily, fill: rl.color });
      prevCaptionRight = rl.right;
    }
    // --- brackets above the sequence ---
    // A rule across the range with a short leg turning down at each end, pointing at the
    // letters it covers. Levels are stacked outermost-first, so where two brackets overlap the
    // wider one sits above the narrower and neither is printed over the other. An end falling
    // at a wrap or panel boundary loses its leg, for the same reason a region edge does: the
    // row ran out there, the range did not.
    const levels = bracketLevels(config);
    levels.forEach((level, li) => {
      const ruleY = rulerY + (levels.length - 1 - li) * BRACKET_ROW_PT + BRACKET_LEG_PT;
      for (const [rs, re] of level) {
        const s = Math.max(rs, row.startRes);
        const e = Math.min(re, row.endRes);
        if (s > e) continue;
        const colour = highlightColorMap.get(`${rs}-${re}`) ?? '#000000';
        const lx = x0(s);
        const rx = x0(e) + cell;
        prims.push({ k: 'line', x1: lx, y1: ruleY, x2: rx, y2: ruleY, stroke: colour, sw: 1.2 });
        if (rs >= row.startRes) {
          prims.push({ k: 'line', x1: lx, y1: ruleY, x2: lx, y2: ruleY + BRACKET_LEG_PT, stroke: colour, sw: 1.2 });
        }
        if (re <= row.endRes) {
          prims.push({ k: 'line', x1: rx, y1: ruleY, x2: rx, y2: ruleY + BRACKET_LEG_PT, stroke: colour, sw: 1.2 });
        }
      }
    });
    y = rulerY + bracketUnits(config) * cell;

    // Clear of the ruler by however far the deepest stack of region frames reaches above the
    // sequence — see regionFrameUnits. Zero when nothing is marked, so an unannotated figure
    // is laid out exactly as before.
    y += regionFrameUnits(config) * cell;

    // --- residue-letter row ---
    const resRowY = y;
    // Normally one cell, but grown when the cell is shorter than a letter with a descender —
    // see residueRowUnits. Everything drawn on this row is sized from it rather than from
    // `cell`, so a region's wash and outline grow with the row instead of cutting across a Q.
    const resRowH = residueRowUnits(config) * cell;

    // Highlight fill washes (clipped to window) are pushed before the letters so they sit
    // BEHIND the text, like a highlighter mark — not on top of it. This also keeps the EPS
    // export correct: PostScript has no true alpha compositing, so a translucent fill drawn
    // after opaque text would paint over and hide it instead of tinting it (see toEps.ts).
    //
    // A span-all region's wash must reach the bottom of the last band, which isn't known
    // until those bands are laid out — but it still has to be painted before the letters,
    // the gridlines and the peptide cells. So its rect is built after the band loop and
    // spliced back in at this index, keeping it at the very back of the paint order.
    const washInsertAt = prims.length;
    highlightGroups.forEach((group, gi) => {
      for (const [rs, re] of group) {
        if (highlightSpanMap.get(`${rs}-${re}`)) continue; // full-height wash spliced in later
        const s = Math.max(rs, row.startRes);
        const e = Math.min(re, row.endRes);
        if (s > e) continue;
        const pad = gi * REGION_FRAME_PAD_PT;
        const hColor = highlightColorMap.get(`${rs}-${re}`) ?? '#000000';
        prims.push({ k: 'rect', x: x0(s) - pad, y: resRowY - pad, w: (e - s + 1) * cell + pad * 2, h: resRowH + pad * 2, fill: hColor, opacity: highlightAlphaMap.get(`${rs}-${re}`) ?? HIGHLIGHT_WASH_ALPHA });
      }
    });
    // A bracketed region keeps its wash — the bracket says where the range is, the tint says
    // which residues are in it. No stagger: brackets are separated by stacking, not by padding.
    for (const [rs, re] of config.highlightRegions) {
      if (!isBracket.has(`${rs}-${re}`)) continue;
      const s = Math.max(rs, row.startRes);
      const e = Math.min(re, row.endRes);
      if (s > e) continue;
      const alpha = highlightAlphaMap.get(`${rs}-${re}`) ?? HIGHLIGHT_WASH_ALPHA;
      if (!(alpha > 0)) continue;
      prims.push({ k: 'rect', x: x0(s), y: resRowY, w: (e - s + 1) * cell, h: resRowH, fill: highlightColorMap.get(`${rs}-${re}`) ?? '#000000', opacity: alpha });
    }

    // Every wash covering a residue, in paint order, so the letter can be inked for legibility
    // against whatever it ends up sitting on — including several overlapping regions.
    const washesAt = (res: number): [string, number][] =>
      config.highlightRegions
        .filter(([rs, re]) => res >= rs && res <= re)
        .map(([rs, re]) => [
          highlightColorMap.get(`${rs}-${re}`) ?? '#000000',
          highlightAlphaMap.get(`${rs}-${re}`) ?? 0,
        ]);

    for (let res = row.startRes; res <= row.endRes; res++) {
      prims.push({
        k: 'text',
        x: x0(res) + cell / 2,
        // Centred on the cell, not on the row: the row may be taller (see residueRowUnits),
        // and that extra height is descender room below the letters, not a reason to move them.
        y: resRowY + cell * 0.5,
        text: proteinSeq[res - 1] ?? '',
        size: config.fontSizes.residue,
        anchor: 'middle',
        family: config.fontFamily,
        fill: inkOnWashes(washesAt(res)),
        center: true,
      });
    }

    // --- highlight region edges (drawn on top; lines never cover content) ---
    // Only the sequence-row-only regions are marked here. A "span all time points" region
    // needs the panel's bottom edge, which isn't known until the bands below are laid out,
    // so its (taller) edges are deferred to after the band loop.
    highlightGroups.forEach((group, gi) => {
      for (const [rs, re] of group) {
        if (highlightSpanMap.get(`${rs}-${re}`)) continue;
        const s = Math.max(rs, row.startRes);
        const e = Math.min(re, row.endRes);
        if (s > e) continue;
        const pad = gi * REGION_FRAME_PAD_PT;
        const hColor = highlightColorMap.get(`${rs}-${re}`) ?? '#000000';
        regionEdges(x0(s) - pad, resRowY - pad, (e - s + 1) * cell + pad * 2, resRowH + pad * 2, hColor, rs >= row.startRes, re <= row.endRes);
      }
    });

    y = resRowY + resRowH;

    // underline the reference-sequence row to separate it from the peptide bands
    prims.push({ k: 'line', x1: colLeft, y1: y, x2: panelRight, y2: y, stroke: '#000', sw: 1.2 });

    const bandsAreaHeight = bandSlices.reduce(
      (sum, bs) => sum + (bs.rowEnd - bs.rowStart) * pitch + (bs.bandComplete ? BAND_GAP_UNITS * cell : 0),
      0,
    );

    // Thin dashed guides between residues — trace a 'line'-style peptide back to its letters.
    if (config.showResidueGridlines) {
      for (let res = row.startRes; res <= row.endRes + 1; res++) {
        const gx = x0(res);
        prims.push({ k: 'line', x1: gx, y1: resRowY, x2: gx, y2: y + bandsAreaHeight, stroke: '#ccc', sw: 0.5, dash: '2 2' });
      }
    }

    // --- time-point bands ---
    for (const bs of bandSlices) {
      const { band, rowStart, rowEnd, bandComplete } = bs;
      const bandTop = y;
      const bandHeight = (rowEnd - rowStart) * pitch;

      prims.push({
        k: 'text',
        x: colLeft - 6,
        y: bandTop + bandHeight / 2,
        text: band.label,
        size: config.fontSizes.timeLabel,
        anchor: 'end',
        family: config.fontFamily,
        fill: '#000',
        center: true,
      });

      for (const cp of band.cells) {
        // Only the peptide rows in this slice's [rowStart, rowEnd); the rest are on another
        // page/column. Offset by rowStart so a continued band's rows sit at the slice top.
        if (cp.rowIndex < rowStart || cp.rowIndex >= rowEnd) continue;
        const ry = bandTop + (cp.rowIndex - rowStart) * pitch;
        const color = config.colors[cp.colorIdx] ?? config.colors[config.colors.length - 1];

        if (config.peptideStyle === 'line') {
          const lineY = ry + pitch / 2;
          prims.push({ k: 'line', x1: x0(cp.start), y1: lineY, x2: x0(cp.end) + cell, y2: lineY, stroke: color, sw: config.lineThickness, opacity: PEPTIDE_ALPHA });
          for (let res = cp.start; res <= cp.end; res++) {
            if ((modSet[cp.id] ?? []).includes(res - cp.fullStart)) {
              const mx = x0(res) + cell / 2;
              prims.push({ k: 'line', x1: mx, y1: ry, x2: mx, y2: ry + pitch, stroke: '#f00', sw: Math.max(1.5, config.lineThickness) });
            }
          }
        } else {
          for (let res = cp.start; res <= cp.end; res++) {
            const isMod = (modSet[cp.id] ?? []).includes(res - cp.fullStart);
            if (isMod) {
              prims.push({ k: 'rect', x: x0(res), y: ry, w: cell, h: cell, fill: '#fff' });
              prims.push({ k: 'rect', x: x0(res), y: ry, w: cell, h: cell, fill: '#f08080', opacity: 0.3, stroke: '#f00', sw: 1 });
            }
            prims.push({ k: 'rect', x: x0(res), y: ry, w: cell, h: cell, fill: color, opacity: PEPTIDE_ALPHA, stroke: isMod ? '#f00' : '#000', sw: isMod ? 2 : 0.5 });
            prims.push({
              k: 'text',
              x: x0(res) + cell / 2,
              y: ry + cell * 0.5,
              text: proteinSeq[res - 1] ?? '',
              size: config.fontSizes.residue,
              anchor: 'middle',
              weight: isMod ? 'bold' : 'normal',
              family: config.fontFamily,
              fill: isMod ? '#f00' : '#000',
              center: true,
            });
          }
        }
      }

      const sepY = bandTop + bandHeight;
      panelFrameBottom = sepY;
      const isPanelLastBand = bandComplete && band === lastBand;
      if (bandComplete && !isPanelLastBand) {
        // Dashed separator between time-point bands within a panel.
        prims.push({ k: 'line', x1: colLeft, y1: sepY, x2: panelRight, y2: sepY, stroke: '#888', sw: 0.8, dash: '4 3' });
        y = sepY + BAND_GAP_UNITS * cell;
      } else if (isPanelLastBand) {
        panelEnds = true; // panel's table ends here — solid bottom border drawn below
        y = sepY + BAND_GAP_UNITS * cell;
      } else {
        y = sepY; // band continues onto the next page/column
      }
    }

    // --- full-height highlight boxes ---
    // One tall rectangle from the reference-sequence row down to the bottom of the last band
    // drawn in this slice, so the residue range reads as boxed across every time point. A
    // region wider than the panel is clipped to the visible residues, so a range crossing a
    // wrap/page boundary gets its own box on each panel it touches.
    //
    // The two halves land at opposite ends of the paint order: the outline is pushed here so
    // the stroke sits above the peptide cells (a stroke-only rect never hides what's under
    // it), while the tinted background is spliced back to `washInsertAt` so it sits behind
    // the letters, gridlines and peptides.
    const spanBottom = Math.max(panelFrameBottom, resRowY + resRowH);
    const spanWashes: Prim[] = [];
    highlightGroups.forEach((group, gi) => {
      for (const [rs, re] of group) {
        if (!highlightSpanMap.get(`${rs}-${re}`)) continue;
        const s = Math.max(rs, row.startRes);
        const e = Math.min(re, row.endRes);
        if (s > e) continue;
        const pad = gi * REGION_FRAME_PAD_PT;
        const hColor = highlightColorMap.get(`${rs}-${re}`) ?? '#000000';
        const box = { x: x0(s) - pad, y: resRowY - pad, w: (e - s + 1) * cell + pad * 2, h: spanBottom - resRowY + pad * 2 };
        spanWashes.push({ k: 'rect', ...box, fill: hColor, opacity: highlightAlphaMap.get(`${rs}-${re}`) ?? SPAN_WASH_ALPHA });
        regionEdges(box.x, box.y, box.w, box.h, hColor, rs >= row.startRes, re <= row.endRes);
      }
    });
    prims.splice(washInsertAt, 0, ...spanWashes);

    // --- this panel's frame ---
    prims.push(
      { k: 'line', x1: colLeft, y1: panelFrameTop, x2: colLeft, y2: panelFrameBottom, stroke: '#000', sw: 1 },
      { k: 'line', x1: panelRight, y1: panelFrameTop, x2: panelRight, y2: panelFrameBottom, stroke: '#000', sw: 1 },
    );
    if (panelEnds) {
      prims.push({ k: 'line', x1: colLeft, y1: panelFrameBottom, x2: panelRight, y2: panelFrameBottom, stroke: '#000', sw: 1 });
    }
    return y;
  }

  // Lay out each column as a vertical stack starting from the common top (below the title).
  let plotBottom = columnTop;
  let plotRight = left;
  for (const col of columns) {
    const colLeft = left + col.xOffset;
    let y = columnTop;
    col.wrapRows.forEach((slice, si) => {
      y = renderSlice(slice, si, colLeft, y);
    });
    plotBottom = Math.max(plotBottom, y);
    plotRight = Math.max(plotRight, colRight(col));
  }

  // Legend overlaid near the lower-right corner, offset/scaled by manual adjustments.
  let legend: Prim[] | undefined;
  let legendBox: DrawnPage['legendBox'];
  if (isLast || config.legendOnEveryPage) {
    const offset = config.legendOffsets[legendId] ?? { x: 0, y: 0 };
    const scale = config.legendScales[legendId] ?? 1;
    const drawn = drawLegend(config, labels, plotRight + offset.x, plotBottom + offset.y, cell, scale);
    legend = drawn.prims;
    legendBox = drawn.box;
  }

  return {
    width,
    height: plotBottom + cell,
    prims,
    legend,
    legendId: legend ? legendId : undefined,
    legendBox,
  };
}

const LEGEND_PAD = 8;  // padding inside the legend background box
const LEGEND_GAP = 6;  // margin between legend box and chart border

/** Legend overlaid in the lower-right corner of the chart area. Draws either a compact
 *  gradient bar or a line-by-line swatch list, based on config.legendStyle. The whole
 *  legend is built at base size, then scaled uniformly about its fixed bottom-right corner
 *  by `scale` (the user's resize handle), so growing/shrinking keeps it pinned in place. */
function drawLegend(
  config: Config,
  labels: string[],
  plotRight: number,
  plotBottom: number,
  cell: number,
  scale = 1,
): { prims: Prim[]; box: { x: number; y: number; w: number; h: number } } {
  const prims: Prim[] = [];
  const n = config.colors.length;
  const fs = config.fontSizes;
  const labelFs = fs.tick;

  const titleText = config.legendTitle;
  const titleW = Math.ceil(titleText.length * fs.legendTitle * 0.62);

  const rowH = Math.max(labelFs + 3, cell);
  let base = { x: 0, y: 0, w: 0, h: 0 };

  function pushBox(boxX: number, boxY: number, boxW: number, boxH: number) {
    base = { x: boxX, y: boxY, w: boxW, h: boxH };
    prims.push({ k: 'rect', x: boxX, y: boxY, w: boxW, h: boxH, fill: '#fff', opacity: 0.93, stroke: '#bbb', sw: 0.8 });
    // Title centered horizontally across the box (baseline near the top).
    prims.push({ k: 'text', x: boxX + boxW / 2, y: boxY + LEGEND_PAD + fs.legendTitle, text: titleText, size: fs.legendTitle, anchor: 'middle', weight: 'bold', family: config.fontFamily, fill: '#000' });
  }

  if (config.legendStyle === 'bar') {
    // --- Gradient bar ---
    const hlFs = Math.round(labelFs * 0.85);
    const barTotalH = n * rowH;
    const barW = Math.max(10, Math.round(cell * 0.9));
    const LBL_GAP = 5;

    // Labels sit BESIDE the bar ends: "High"/"Low" (or actual max/min values) next to the
    // top (high) and bottom (low) colour cells.
    const topLabel = config.legendBarLabels === 'numbers'
      ? (labels[n - 1] ?? '').split(' - ').slice(-1)[0]  // upper bound of highest bin
      : 'High';
    const bottomLabel = config.legendBarLabels === 'numbers'
      ? (labels[0] ?? '').split(' - ')[0]                // lower bound of lowest bin
      : 'Low';
    const hlLabelW = Math.ceil(Math.max(topLabel.length, bottomLabel.length) * hlFs * 0.6);

    const blockW = barW + LBL_GAP + hlLabelW;
    const innerW = Math.max(blockW, titleW);
    const innerH = (fs.legendTitle + 6) + barTotalH;
    const boxW = innerW + LEGEND_PAD * 2;
    const boxH = innerH + LEGEND_PAD * 2;
    const boxX = plotRight - LEGEND_GAP - boxW;
    const boxY = plotBottom - LEGEND_GAP - boxH;

    pushBox(boxX, boxY, boxW, boxH);

    const contentY = boxY + LEGEND_PAD + fs.legendTitle + 6;
    // Centre the bar+labels block under the centred title when the title is wider.
    const barX = boxX + LEGEND_PAD + (innerW - blockW) / 2;

    // Gradient bar (highest colour at top, lowest at bottom).
    for (let i = 0; i < n; i++) {
      prims.push({ k: 'rect', x: barX, y: contentY + i * rowH, w: barW, h: rowH, fill: config.colors[n - 1 - i], opacity: PEPTIDE_ALPHA });
    }
    // High label beside the top cell, Low label beside the bottom cell (vertically centred
    // on those cells).
    const lblX = barX + barW + LBL_GAP;
    prims.push({ k: 'text', x: lblX, y: contentY + rowH / 2, text: topLabel, size: hlFs, anchor: 'start', family: config.fontFamily, fill: '#555', center: true });
    prims.push({ k: 'text', x: lblX, y: contentY + barTotalH - rowH / 2, text: bottomLabel, size: hlFs, anchor: 'start', family: config.fontFamily, fill: '#555', center: true });

  } else {
    // --- Line-by-line swatch list (low → high, top to bottom) ---
    const swatchSz = Math.min(cell, rowH - 2);
    const maxLabelLen = labels.reduce((m, l) => Math.max(m, l.length), 0);
    const labelColW = Math.ceil(maxLabelLen * labelFs * 0.6);
    const GAP = 6;

    const blockW = swatchSz + GAP + labelColW;
    const innerW = Math.max(blockW, titleW);
    const innerH = (fs.legendTitle + 6) + n * rowH;
    const boxW = innerW + LEGEND_PAD * 2;
    const boxH = innerH + LEGEND_PAD * 2;
    const boxX = plotRight - LEGEND_GAP - boxW;
    const boxY = plotBottom - LEGEND_GAP - boxH;

    pushBox(boxX, boxY, boxW, boxH);

    const contentY = boxY + LEGEND_PAD + fs.legendTitle + 6;
    // Centre the swatch + label block under the centred title, and centre each numeric
    // label within its column so the notation reads as a tidy centred column.
    const blockX = boxX + LEGEND_PAD + (innerW - blockW) / 2;
    const labelCenterX = blockX + swatchSz + GAP + labelColW / 2;

    for (let i = 0; i < n; i++) {
      const ry = contentY + i * rowH;
      prims.push({ k: 'rect', x: blockX, y: ry + (rowH - swatchSz) / 2, w: swatchSz, h: swatchSz, fill: config.colors[i], opacity: PEPTIDE_ALPHA, stroke: '#888', sw: 0.5 });
      prims.push({ k: 'text', x: labelCenterX, y: ry + rowH / 2, text: labels[i], size: labelFs, anchor: 'middle', family: config.fontFamily, fill: '#000', center: true });
    }
  }

  if (scale === 1) return { prims, box: base };

  // Scale the whole legend uniformly about its bottom-right corner (which stays fixed, so
  // the legend keeps its anchored position while growing/shrinking toward the top-left).
  const brx = base.x + base.w;
  const bry = base.y + base.h;
  const tx = (x: number) => brx + (x - brx) * scale;
  const ty = (y: number) => bry + (y - bry) * scale;
  const scaled = prims.map((p): Prim => {
    if (p.k === 'rect') return { ...p, x: tx(p.x), y: ty(p.y), w: p.w * scale, h: p.h * scale, sw: p.sw != null ? p.sw * scale : p.sw };
    if (p.k === 'line') return { ...p, x1: tx(p.x1), y1: ty(p.y1), x2: tx(p.x2), y2: ty(p.y2), sw: p.sw * scale };
    return { ...p, x: tx(p.x), y: ty(p.y), size: p.size * scale };
  });
  return { prims: scaled, box: { x: tx(base.x), y: ty(base.y), w: base.w * scale, h: base.h * scale } };
}
