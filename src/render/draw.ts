// Pure SVG primitive builder. Turns a figure/page of layout into geometry-only
// descriptors that the React components render. Keeping this pure makes it testable
// and reusable for PNG/SVG export. SVG user units == px; at natural (1:1) scale,
// a configured font size of N renders as N px, so print/export honor the chosen sizes.

import { Config } from '../state/config';
import { cellSize, FigureLayout, leftLabelWidth, rowPitch, WrapRowSlice } from '../model/layout';
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

const RULER_UNITS = 1.6;
const RESIDUE_ROW_UNITS = 1;
const BAND_GAP_UNITS = 1;
const PANEL_GAP_UNITS = 1.5;
const TITLE_UNITS = 3;
const PEPTIDE_ALPHA = 0.7;

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
  const highlightGroups = groupOverlappingRegions(config.highlightRegions);
  // Map "start-end" → chosen color so we can look up stroke color inside the row loop
  // even after groupOverlappingRegions reorders the regions.
  const highlightColorMap = new Map<string, string>(
    config.highlightRegions.map((r, i) => [
      `${r[0]}-${r[1]}`,
      (config.highlightColors ?? [])[i] ?? '#000000',
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
    const panelFrameTop = y;
    const panelRight = colLeft + (row.endRes - row.startRes + 1) * cell;
    const lastBand = row.bands[row.bands.length - 1];
    let panelFrameBottom = y;
    let panelEnds = false;
    const x0 = (res: number) => colLeft + (res - row.startRes) * cell;

    // --- ruler ---
    const rulerY = y + RULER_UNITS * cell;
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
        prims.push({ k: 'line', x1: tickX, y1: rulerY - 2, x2: tickX, y2: rulerY, stroke: '#999', sw: 0.8 });
        prevLabelRight = labelRight;
      }
    }
    y = rulerY;

    // --- residue-letter row ---
    const resRowY = y;

    // Highlight fill washes (clipped to window) are pushed before the letters so they sit
    // BEHIND the text, like a highlighter mark — not on top of it. This also keeps the EPS
    // export correct: PostScript has no true alpha compositing, so a translucent fill drawn
    // after opaque text would paint over and hide it instead of tinting it (see toEps.ts).
    highlightGroups.forEach((group, gi) => {
      for (const [rs, re] of group) {
        const s = Math.max(rs, row.startRes);
        const e = Math.min(re, row.endRes);
        if (s > e) continue;
        const pad = gi * 2;
        const hColor = highlightColorMap.get(`${rs}-${re}`) ?? '#000000';
        prims.push({ k: 'rect', x: x0(s) - pad, y: resRowY - pad, w: (e - s + 1) * cell + pad * 2, h: cell + pad * 2, fill: hColor, opacity: 0.12 });
      }
    });

    for (let res = row.startRes; res <= row.endRes; res++) {
      prims.push({
        k: 'text',
        x: x0(res) + cell / 2,
        y: resRowY + cell * 0.5,
        text: proteinSeq[res - 1] ?? '',
        size: config.fontSizes.residue,
        anchor: 'middle',
        family: config.fontFamily,
        fill: '#000',
        center: true,
      });
    }

    // --- highlight border outlines (drawn on top; a stroke-only rect never covers content) ---
    highlightGroups.forEach((group, gi) => {
      for (const [rs, re] of group) {
        const s = Math.max(rs, row.startRes);
        const e = Math.min(re, row.endRes);
        if (s > e) continue;
        const pad = gi * 2;
        const hColor = highlightColorMap.get(`${rs}-${re}`) ?? '#000000';
        prims.push({ k: 'rect', x: x0(s) - pad, y: resRowY - pad, w: (e - s + 1) * cell + pad * 2, h: cell + pad * 2, fill: 'none', stroke: hColor, sw: 1.5 });
      }
    });

    y = resRowY + RESIDUE_ROW_UNITS * cell;

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
