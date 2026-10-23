// Sequence-wide overview panel: coverage above, peptide starts and ends below, with the
// anchor threshold each terminus tally has to clear drawn over them. It shows the numbers
// cluster detection actually works from, so a boundary that looks wrong on the figure can be
// traced back to the tallies that produced it.
//
// Residue identification is the whole point of the panel, so positions are labelled BETWEEN
// the two plots — right beside the terminus bars, which are what you need to identify —
// as well as underneath, with a gridline every ten residues running through both plots and a
// crosshair that names the residue under the pointer.
//
// This is an on-screen analysis view, not part of the figure: it carries `data-ui-only` so it
// never prints, and it has no `data-export-id`, so PNG/JPEG/SVG/EPS export skips it too.

import { useEffect, useMemo, useRef, useState } from 'react';
import { saveAs } from 'file-saver';
import * as XLSX from 'xlsx';
import { useContainerWidth } from './useContainerWidth';
import { Config, datetimeSuffix, sanitizeFilename } from '../state/config';
import { setConfig } from '../state/store';
import { Peptide } from '../model/peptides';
import { anchorFlags, binSize, buildResidueProfile } from '../model/profile';
import { buildCleavageTable } from '../model/cleavage';
import { RegionSummary, SKEW_FLAG, summariseRegions } from '../model/regions';
import { computeIntensityScale, passesFilters } from '../model/filtering';
import { visiblePeptides } from '../model/clusters';
import { formatNumber } from '../model/intensity';
import { svgBlob } from '../export/toSvg';
import { svgToJpegBlob, svgToPngBlob } from '../export/toRaster';

const COV = '#2563eb';
const START = '#e2632c';
const END = '#0f9268';
const INK = '#374151';
const MUTED = '#6b7280';
const GRID = '#e8eaee';
const AXIS = '#c8ccd3';

// Layout in SVG user units, which are points — the same convention the figure uses, so 1 unit
// renders as 1 pt and a font size of N is N pt on screen and in an export.
//
// The plot width is measured from the container rather than fixed, and the SVG is then drawn at
// its natural size. That is what the figure does, and it matters: scaling a fixed-width SVG to
// fit would scale the type with it, so labels would shrink on a narrow window and balloon on a
// wide one. Measuring instead keeps every label at a constant, readable size and spends the
// extra width on the data.
const MIN_W = 700; // below this the panel scrolls rather than cramming
const PX_TO_PT = 72 / 96;
// Closest zoom, in residues across the plot. A dozen is enough to read individual bars and
// their exact positions without the axis becoming a handful of numbers.
const MIN_SPAN = 12;
const ZOOM_STEP = 1.6;
const ML = 54;
const MR = 14;
const COV_TOP = 16;
const COV_H = 150;
const COV_BOT = COV_TOP + COV_H;
const SCALE_H = 30; // the residue ruler, between the plots
const TERM_TOP = COV_BOT + SCALE_H;
const TERM_H = 170;
const TERM_BOT = TERM_TOP + TERM_H;
const TERM_MID = TERM_TOP + TERM_H / 2;
const FOOT = 30;
const TABLE_TOP = TERM_BOT + FOOT;

// The marked-region summary is drawn inside this SVG rather than beside it as HTML, so that
// saving the plot saves the numbers with it — the export path serialises the SVG and nothing
// else. Heights are fixed per row so the viewBox can be sized before anything is drawn.
const TABLE_TITLE = 34; // title baseline to header baseline — 20 put the two on top of each other
const TABLE_HEAD = 17;
const TABLE_ROW = 15;
const TABLE_NOTE = 16; // the skew footnote, only present when something is flagged
const tableHeight = (rows: number, note: boolean) =>
  rows ? TABLE_TITLE + TABLE_HEAD + rows * TABLE_ROW + (note ? TABLE_NOTE : 0) + 8 : 0;
const TABLE_GAP = 22; // between the two tables, enough for the second one's title to breathe

/** Column layout as [heading, share of the plot width, right-aligned]. Shares sum to 1, so the
 *  table stays aligned to the same left and right edges as the axes at any width. */
const COLS: [string, number, boolean][] = [
  ['Region', 0.165, false],
  ['Residues', 0.090, true],
  ['Length', 0.066, true],
  ['Peptides', 0.075, true],
  ['N-terminal cleavage', 0.135, true],
  ['C-terminal cleavage', 0.135, true],
  ['Lowest intensity', 0.111, true],
  ['Median intensity', 0.111, true],
  ['Highest intensity', 0.112, true],
];

/** What each column sorts on, by column index in COLS. Only the region name is text; sorting
 *  "Residues" by its start position is what reading a range left to right means. */
function sortValue(r: RegionSummary, col: number): number | string {
  switch (col) {
    case 0: return r.label.toLowerCase();
    case 1: return r.start;
    case 2: return r.end - r.start + 1;
    case 3: return r.peptideCount;
    case 4: return r.nTerminalCleavage;
    case 5: return r.cTerminalCleavage;
    case 6: return r.minIntensity;
    case 7: return r.medianIntensity;
    default: return r.maxIntensity;
  }
}

function tickStep(seqLength: number, innerW: number): number {
  // Aim for a label roughly every 70px, snapped to a round number of residues.
  const target = (seqLength / innerW) * 70;
  return [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000].find((s) => s >= target) ?? 1000;
}

export function CoverageProfile({
  peptides,
  proteinSeq,
  config,
}: {
  peptides: Peptide[];
  proteinSeq: string;
  config: Config;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  // While an edge is being dragged the change is held locally — committing on every pointer
  // move would redraw the whole figure underneath on each pixel.
  const [drag, setDrag] = useState<{ region: number; edge: 0 | 1; at: number } | null>(null);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  // Which table was last copied, so the button can confirm it. Cleared on a timer — a copy
  // leaves nothing on screen to look at, so without this there is no sign it worked.
  const [copied, setCopied] = useState<'regions' | 'time' | 'cleavage' | null>(null);
  // The residue range on screen. null means the whole sequence, which is how the panel opens —
  // on a long protein the bars are then only a pixel or two wide, so zooming into a stretch is
  // the only way to read individual positions.
  const [view, setView] = useState<[number, number] | null>(null);
  // Table sort order. null is the order the regions were marked in, which is what the figure
  // shows, so the table opens agreeing with it. Sorting is view-only: it reorders these rows
  // and the exported table, and never touches the regions or the figure.
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [panning, setPanning] = useState<{ clientX: number; from: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [plotRef, plotPx] = useContainerWidth<HTMLDivElement>();
  const seqLength = proteinSeq.length;
  // Width in points, from the space the panel actually has — the figure's own approach. Rounded
  // down off a spare pixel so a rounding overshoot can't trip a horizontal scrollbar.
  const W = Math.max(MIN_W, Math.floor((plotPx - 2) * PX_TO_PT));

  // Clamped on read rather than on write, so loading a different protein can never leave a
  // range pointing past the end of the sequence.
  const from = view ? Math.max(1, Math.min(view[0], seqLength)) : 1;
  const to = view ? Math.min(seqLength, Math.max(view[1], from)) : seqLength;
  const span = to - from + 1;

  /** Zoom by `factor` about `centre`, keeping that residue under the same point on screen. */
  function zoomAt(centre: number, factor: number) {
    const wanted = Math.round(span * factor);
    if (wanted >= seqLength) return setView(null);
    const next = Math.max(MIN_SPAN, Math.min(seqLength, wanted));
    const share = span > 1 ? (centre - from) / span : 0.5;
    const start = Math.max(1, Math.min(seqLength - next + 1, Math.round(centre - share * next)));
    setView([start, start + next - 1]);
  }

  function panBy(residues: number) {
    if (!view) return;
    const start = Math.max(1, Math.min(seqLength - span + 1, from + residues));
    setView([start, start + span - 1]);
  }

  /**
   * The panel is deliberately absent from the figure exports — it explains the figure rather
   * than being part of it — so it carries its own. EPS is not offered: `toEps` translates
   * rect/line/text only, and this chart is drawn from polylines, which would silently come out
   * empty.
   */
  async function saveProfile(kind: 'png' | 'jpeg' | 'svg') {
    const svg = svgRef.current;
    if (!svg) return;
    setExportMsg(null);
    try {
      let name = `${sanitizeFilename(config.titleText)}_coverage_profile`;
      if (config.addDatetimeToFilename) name = `${name}_${datetimeSuffix()}`;
      const blob =
        kind === 'svg'
          ? svgBlob(svg)
          : kind === 'png'
          ? await svgToPngBlob(svg, config.pngDpi)
          : await svgToJpegBlob(svg, config.pngDpi);
      saveAs(blob, `${name}.${kind === 'jpeg' ? 'jpg' : kind}`);
    } catch (e) {
      setExportMsg(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * The table as data rather than as a picture. Intensities go out as raw numbers, not in the
   * figure's notation: a spreadsheet can format them, but it cannot get back the digits that
   * "4.8 × 10⁷" threw away. The protein title leads each row so exports from several proteins
   * can simply be stacked.
   */
  function tableRows() {
    const title = config.titleText || 'Protein';
    return sortedSummary.map((r) => ({
      Protein: title,
      Region: r.label,
      Start: r.start,
      End: r.end,
      'Length (aa)': r.end - r.start + 1,
      Peptides: r.peptideCount,
      'N-terminal cleavage': r.nTerminalCleavage,
      'C-terminal cleavage': r.cTerminalCleavage,
      'Lowest intensity': r.minIntensity,
      // Both averages go out, side by side: the plot has room for only one, and seeing how far
      // apart they are is the whole reason the median is the one it shows.
      'Median intensity': r.medianIntensity,
      'Mean intensity': r.meanIntensity,
      'Highest intensity': r.maxIntensity,
      'Right-skewed': r.skew >= SKEW_FLAG ? 'yes' : 'no',
    }));
  }

  /**
   * The per-time-point table as data. One row per region drawn across every track, one column
   * per time point, so it pastes straight into a plot of peptide count against time. The pooled
   * total rides along because it is what the first table's `Peptides` column reports, and having
   * both in one sheet is what shows a region shedding peptides rather than simply having few.
   */
  function timeRows() {
    const title = config.titleText || 'Protein';
    return spanRows.map((r) => {
      const row: Record<string, string | number> = {
        Protein: title,
        Region: r.label,
        Start: r.start,
        End: r.end,
      };
      config.intensityCols.forEach((col, ci) => {
        row[timeLabel(col)] = r.perColumn[ci] ?? 0;
      });
      row['All time points'] = r.peptideCount;
      return row;
    });
  }

  /**
   * Every bond in the sequence, with the evidence for it at each time point. Built on demand.
   *
   * `all` takes every peptide in the file, ignoring the Filters section entirely — no length
   * limits, no intensity limits — with presence at a time point meaning nothing more than a
   * non-zero value there. That sheet is the raw observation; the filtered one is what the
   * figure shows. Having both in one workbook is what lets a reviewer see that a site did not
   * appear because the filters removed it.
   */
  function cleavageBonds(all: boolean) {
    if (!model) return [];
    return all
      ? buildCleavageTable(
          peptides,
          proteinSeq,
          config.intensityCols,
          (p, col) => (p.intensity[col] ?? 0) > 0,
        )
      : buildCleavageTable(model.visible, proteinSeq, config.intensityCols, (p, col) =>
          passesFilters(p, col, config, model.scale),
        );
  }

  /**
   * The wide sheet: one column per bond, one row per time point. Three header rows name the
   * bond and the residues either side of it, so a column can be read without counting along the
   * sequence. Laid out this way because a time course is then a single row to select and plot.
   */
  function cleavageMatrix(all = false): string[][] {
    const bonds = cleavageBonds(all);
    if (!bonds.length) return [];
    const label = (b: (typeof bonds)[number]) => `${b.p1}-${b.p1 + 1}`;
    return [
      ['Protein', config.titleText || 'Protein'],
      ['Peptides', all ? 'all in the file, no filters applied' : 'as filtered for the figure'],
      ["Bond (P1-P1')", ...bonds.map(label)],
      ['P1', ...bonds.map((b) => `${b.p1aa}${b.p1}`)],
      ["P1'", ...bonds.map((b) => `${b.p1PrimeAa}${b.p1 + 1}`)],
      ...config.intensityCols.map((col, ci) => [
        timeLabel(col),
        ...bonds.map((b) => String(b.total[ci] ?? 0)),
      ]),
      ['All time points', ...bonds.map((b) => String(b.pooledTotal))],
    ];
  }

  /**
   * The same numbers one row per bond and time point, with the two sides kept apart. This is
   * the shape R, Python and Prism want, and it is where you look to see whether a bond is
   * supported from both directions or only one.
   */
  function cleavageDetailRows(all = false) {
    const bonds = cleavageBonds(all);
    const title = config.titleText || 'Protein';
    const rows: Record<string, string | number>[] = [];
    for (const b of bonds) {
      const shared = {
        Protein: title,
        Bond: `${b.p1}-${b.p1 + 1}`,
        P1: b.p1,
        'P1 aa': b.p1aa,
        "P1'": b.p1 + 1,
        "P1' aa": b.p1PrimeAa,
      };
      config.intensityCols.forEach((col, ci) => {
        rows.push({
          ...shared,
          'Time point': timeLabel(col),
          'From C-termini': b.fromC[ci] ?? 0,
          'From N-termini': b.fromN[ci] ?? 0,
          Total: b.total[ci] ?? 0,
        });
      });
      rows.push({
        ...shared,
        'Time point': 'All time points',
        'From C-termini': b.pooledFromC,
        'From N-termini': b.pooledFromN,
        Total: b.pooledTotal,
      });
    }
    return rows;
  }

  function saveCleavage(kind: 'tsv' | 'xlsx') {
    const cells = cleavageMatrix();
    if (!cells.length) return;
    setExportMsg(null);
    try {
      let name = `${sanitizeFilename(config.titleText)}_cleavage_by_bond`;
      if (config.addDatetimeToFilename) name = `${name}_${datetimeSuffix()}`;
      if (kind === 'tsv') {
        const text = '﻿' + cells.map((r) => r.join('\t')).join('\r\n') + '\r\n';
        saveAs(new Blob([text], { type: 'text/tab-separated-values;charset=utf-8' }), `${name}.tsv`);
      } else {
        // Four sheets: the wide table each way, then the N/C breakdown each way. A TSV holds one
        // sheet, so both the unfiltered counts and the breakdown travel only in the workbook.
        const wb = XLSX.utils.book_new();
        const sheet = (name: string, data: XLSX.WorkSheet) =>
          XLSX.utils.book_append_sheet(wb, data, name);
        sheet('Cleavage (filtered)', XLSX.utils.aoa_to_sheet(cells));
        sheet('Cleavage (all peptides)', XLSX.utils.aoa_to_sheet(cleavageMatrix(true)));
        sheet('Detail (filtered)', XLSX.utils.json_to_sheet(cleavageDetailRows()));
        sheet('Detail (all peptides)', XLSX.utils.json_to_sheet(cleavageDetailRows(true)));
        const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
        saveAs(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${name}.xlsx`);
      }
    } catch (e) {
      setExportMsg(e instanceof Error ? e.message : String(e));
    }
  }

  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /**
   * The same rows as the export, on the clipboard instead of on disk. Two flavours go on at
   * once: tab-separated text, which Excel and Prism split into columns on paste, and an HTML
   * table, which Word and Google Docs paste as a real table. The receiving application picks
   * whichever it understands, so one button covers both.
   */
  async function copyTable(which: 'regions' | 'time' | 'cleavage') {
    const cells =
      which === 'cleavage'
        ? cleavageMatrix()
        : (() => {
            const rows: Record<string, unknown>[] = which === 'time' ? timeRows() : tableRows();
            if (!rows.length) return [];
            const headers = Object.keys(rows[0]);
            return [headers, ...rows.map((r) => headers.map((h) => String(r[h] ?? '')))];
          })();
    if (!cells.length) return;
    setExportMsg(null);
    const tsv = cells.map((c) => c.join('\t')).join('\n');
    const cellTag = (v: string, head: boolean) =>
      head ? `<th>${escapeHtml(v)}</th>` : `<td>${escapeHtml(v)}</td>`;
    const html =
      `<table>${cells
        .map((c, i) => `<tr>${c.map((v) => cellTag(v, i === 0)).join('')}</tr>`)
        .join('')}</table>`;
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([tsv], { type: 'text/plain' }),
            'text/html': new Blob([html], { type: 'text/html' }),
          }),
        ]);
      } else {
        // Older browsers, and any page not served over https, where only plain text is allowed.
        await navigator.clipboard.writeText(tsv);
      }
      setCopied(which);
    } catch (e) {
      setExportMsg(e instanceof Error ? e.message : String(e));
    }
  }

  function saveTable(kind: 'tsv' | 'xlsx', which: 'regions' | 'time' = 'regions') {
    const rows = which === 'time' ? timeRows() : tableRows();
    if (!rows.length) return;
    setExportMsg(null);
    try {
      let name = `${sanitizeFilename(config.titleText)}_${
        which === 'time' ? 'peptides_by_timepoint' : 'marked_regions'
      }`;
      if (config.addDatetimeToFilename) name = `${name}_${datetimeSuffix()}`;
      if (kind === 'tsv') {
        const headers = Object.keys(rows[0]);
        const body = rows.map((r) => headers.map((h) => String(r[h as keyof typeof r])).join('\t'));
        // A BOM and CRLF endings so Excel opens it as UTF-8 without a wizard.
        const text = '﻿' + [headers.join('\t'), ...body].join('\r\n') + '\r\n';
        saveAs(new Blob([text], { type: 'text/tab-separated-values;charset=utf-8' }), `${name}.tsv`);
      } else {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(
          wb,
          XLSX.utils.json_to_sheet(rows),
          which === 'time' ? 'By time point' : 'Marked regions',
        );
        const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
        saveAs(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${name}.xlsx`);
      }
    } catch (e) {
      setExportMsg(e instanceof Error ? e.message : String(e));
    }
  }

  const model = useMemo(() => {
    if (!open || !seqLength || !peptides.length) return null;
    const scale = computeIntensityScale(peptides, config.intensityCols, config);
    const visible = visiblePeptides(peptides, config.intensityCols, config, scale);
    // Built from the filtered peptides, not every row in the file. Detection counts only what
    // passes the Filters section, so a profile built from the raw rows would report bigger
    // tallies than the detector ever sees and draw its threshold against the wrong baseline.
    const prof = buildResidueProfile(visible, seqLength, config.clusterMaxLength);
    return {
      // Kept so the cleavage export can be built on click rather than on every render — it is
      // a whole-sequence table nobody looks at until they ask for the file.
      visible,
      scale,
      prof,
      startAnchor: anchorFlags(prof.starts, prof.avgStarts, seqLength, config.clusterMinSharedPeptides, config.clusterEnrichmentFactor),
      endAnchor: anchorFlags(prof.ends, prof.avgEnds, seqLength, config.clusterMinSharedPeptides, config.clusterEnrichmentFactor),
      summary: summariseRegions(
        config.highlightRegions,
        config.highlightLabels ?? [],
        config.highlightColors ?? [],
        visible,
        config.intensityCols,
        config.highlightSpanAll ?? [],
        // The figure's own test, so a per-time-point count is exactly the number of bands the
        // region covers on that track — not a second opinion about what counts as present.
        (p, col) => passesFilters(p, col, config, scale),
        config.clusterMembershipPercent,
      ),
    };
  }, [open, peptides, seqLength, config]);

  // Sorted once per render and used by both the drawn table and the export, so a saved file is
  // always in the order that was on screen when it was saved. A handful of rows sorted on click
  // costs nothing next to the profile behind it, which is not recomputed here at all.
  const sortedSummary = useMemo(() => {
    const rows = model?.summary ?? [];
    if (!sort) return rows;
    const { col, dir } = sort;
    return [...rows].sort((a, b) => {
      const x = sortValue(a, col);
      const y = sortValue(b, col);
      const c = typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number);
      return c * dir;
    });
  }, [model, sort]);

  // The per-time-point table covers only the regions drawn across every track. A region marked
  // on a single track says nothing about the others, so breaking it down by time point would
  // read as a claim the figure never made.
  const spanRows = sortedSummary.filter((r) => r.spanAll);
  const timeLabel = (col: string) => config.timeLabels[col] ?? col;

  /** Click a heading: first click sorts low to high, then high to low, then back to the order
   *  the regions were marked in. */
  function toggleSort(col: number) {
    setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null));
  }

  const innerW = W - ML - MR;
  const x0 = (res: number) => ML + ((res - from) / span) * innerW;
  const step = tickStep(span, innerW);

  function residueAt(clientX: number): number | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const box = svg.getBoundingClientRect();
    const sx = ((clientX - box.left) / box.width) * W;
    if (sx < ML || sx > W - MR) return null;
    return Math.min(to, Math.max(from, from + Math.floor(((sx - ML) / innerW) * span)));
  }

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  // The wheel handler has to be attached natively: React's synthetic wheel listener is passive,
  // so preventDefault there is ignored and the page scrolls away underneath the zoom.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !open) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const centre = residueAt(e.clientX) ?? Math.round((from + to) / 2);
      zoomAt(centre, e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [open, from, to, span, seqLength, W]);

  if (!seqLength || !peptides.length) return null;

  // Edges move freely, one residue at a time — they are not pulled onto positions the
  // detector likes. The solid bars already show where peptides agree, so you can land on one
  // deliberately; the point of dragging is to overrule the detector, which snapping defeats.
  function commitDrag(regionIndex: number, edge: 0 | 1, residue: number) {
    const regions = config.highlightRegions.map((r, i) => {
      if (i !== regionIndex) return r;
      const next: [number, number] = edge === 0 ? [residue, r[1]] : [r[0], residue];
      return (next[0] <= next[1] ? next : [next[1], next[0]]) as [number, number];
    });
    // A dragged region is now the user's, not the detector's, so a later re-run leaves it be.
    const auto = (config.highlightAuto ?? []).map((v, i) => (i === regionIndex ? false : v));
    while (auto.length < regions.length) auto.push(false);
    setConfig({ highlightRegions: regions, highlightAuto: auto });
  }

  return (
    <section className="profile" data-ui-only="1">
      <div className="profile-head">
        <button onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? '▾' : '▸'} Coverage &amp; termini profile
        </button>
        <span className="muted">
          {open
            ? 'Peptides covering each residue, and where their N- and C-termini fall. Solid bars are high enough above their surroundings to start a cluster.'
            : 'Show the per-residue numbers cluster detection works from.'}
        </span>
      </div>

      {open && model && (() => {
        const { prof, startAnchor, endAnchor, summary } = model;
        // Binning is decided by what is on screen, not by the whole protein — which is the
        // point of zooming: a 3,000-residue protein merges bars when fully out, and shows one
        // bar per residue as soon as the visible stretch is short enough.
        const bin = binSize(span);
        const anySkewed = summary.some((r) => r.skew >= SKEW_FLAG);
        const table1H = tableHeight(summary.length, anySkewed);
        // The second table follows the first, so its top has to be known before either is drawn.
        const timeTop = TABLE_TOP + table1H + (spanRows.length ? TABLE_GAP : 0);
        const H = timeTop + tableHeight(spanRows.length, false);
        const covMax = Math.max(1, prof.maxCoverage);
        const termMax = Math.max(1, prof.maxTerminus);
        const covY = (v: number) => COV_BOT - (v / covMax) * COV_H;
        const upY = (v: number) => TERM_MID - (v / termMax) * (TERM_H / 2);
        const dnY = (v: number) => TERM_MID + (v / termMax) * (TERM_H / 2);
        const barW = Math.max(1, (innerW / span) * bin - 1.2);

        // Only the visible stretch is built, so zooming in costs no more than zooming out.
        // A bin keeps the tallest value it covers, so a pile-up is never averaged away.
        const bars: { res: number; starts: number; ends: number; sa: boolean; ea: boolean }[] = [];
        for (let res = from; res <= to; res += bin) {
          let s = 0, e = 0, sa = false, ea = false;
          for (let k = res; k < res + bin && k <= to; k++) {
            s = Math.max(s, prof.starts[k]);
            e = Math.max(e, prof.ends[k]);
            sa = sa || startAnchor[k];
            ea = ea || endAnchor[k];
          }
          bars.push({ res, starts: s, ends: e, sa, ea });
        }

        const covPts: string[] = [];
        for (let res = from; res <= to; res++) covPts.push(`${x0(res).toFixed(1)},${covY(prof.coverage[res]).toFixed(1)}`);

        const ticks: number[] = [];
        for (let r = Math.ceil(from / step) * step; r <= to; r += step) ticks.push(r);
        const minor: number[] = [];
        if (step >= 10) {
          for (let r = Math.ceil(from / step) * step - step / 2; r <= to; r += step) {
            if (r >= from) minor.push(r);
          }
        }

        const thr = (arr: number[], yf: (v: number) => number) => {
          const pts: string[] = [];
          for (let res = from; res <= to; res++) {
            pts.push(`${x0(res).toFixed(1)},${yf(Math.min(arr[res] * config.clusterEnrichmentFactor, termMax)).toFixed(1)}`);
          }
          return pts.join(' ');
        };

        const covTicks = [0, covMax / 2, covMax].map((v) => Math.round(v));
        const termTicks = [Math.round(termMax / 2), termMax];

        return (
          <>
            <div className="profile-legend">
              <span><i style={{ background: COV }} /> Coverage</span>
              <span><i style={{ background: START }} /> N-termini</span>
              <span><i style={{ background: END }} /> C-termini</span>
              <span><i className="ln" style={{ background: INK }} /> Threshold for starting a cluster</span>
              {bin > 1 && <span className="muted">1 bar = {bin} residues</span>}
              {config.highlightRegions.length > 0 && (
                <span className="muted">
                  Drag a cluster edge to any residue. Click a table heading to sort.
                </span>
              )}
              {sort && (
                <button onClick={() => setSort(null)} title="Back to the order the regions were marked in">
                  Clear sort
                </button>
              )}
              <span className="profile-zoom">
                <button
                  onClick={() => zoomAt(Math.round((from + to) / 2), ZOOM_STEP)}
                  disabled={!view}
                  title="Zoom out"
                >
                  −
                </button>
                <b>
                  {from}–{to}
                </b>
                <button
                  onClick={() => zoomAt(Math.round((from + to) / 2), 1 / ZOOM_STEP)}
                  disabled={span <= MIN_SPAN}
                  title="Zoom in"
                >
                  +
                </button>
                <button onClick={() => setView(null)} disabled={!view}>
                  Fit
                </button>
                <span className="muted">
                  {view ? 'scroll to zoom, drag to pan' : `of ${seqLength} — scroll to zoom in`}
                </span>
              </span>
              <span className="profile-save">
                Plot:
                <button onClick={() => saveProfile('png')}>PNG</button>
                <button onClick={() => saveProfile('jpeg')}>JPEG</button>
                <button onClick={() => saveProfile('svg')}>SVG</button>
                {summary.length > 0 && (
                  <>
                    <span className="sep" aria-hidden="true">·</span>
                    Regions:
                    <button onClick={() => copyTable('regions')} title="Copy to the clipboard — paste straight into Excel">
                      {copied === 'regions' ? 'Copied ✓' : 'Copy'}
                    </button>
                    <button onClick={() => saveTable('tsv')}>TSV</button>
                    <button onClick={() => saveTable('xlsx')}>XLSX</button>
                  </>
                )}
                {spanRows.length > 0 && (
                  <>
                    <span className="sep" aria-hidden="true">·</span>
                    By time point:
                    <button onClick={() => copyTable('time')} title="Copy to the clipboard — paste straight into Excel">
                      {copied === 'time' ? 'Copied ✓' : 'Copy'}
                    </button>
                    <button onClick={() => saveTable('tsv', 'time')}>TSV</button>
                    <button onClick={() => saveTable('xlsx', 'time')}>XLSX</button>
                  </>
                )}
                {proteinSeq.length > 1 && config.intensityCols.length > 0 && (
                  <>
                    <span className="sep" aria-hidden="true">·</span>
                    Cleavage:
                    <button
                      onClick={() => copyTable('cleavage')}
                      title="Copy the filtered table — one column per bond, one row per time point"
                    >
                      {copied === 'cleavage' ? 'Copied ✓' : 'Copy'}
                    </button>
                    <button onClick={() => saveCleavage('tsv')} title="Filtered peptides only">
                      TSV
                    </button>
                    <button
                      onClick={() => saveCleavage('xlsx')}
                      title="Four sheets: filtered and unfiltered, each with an N-/C-side breakdown"
                    >
                      XLSX
                    </button>
                  </>
                )}
                {exportMsg && <span className="error">{exportMsg}</span>}
              </span>
            </div>

            <div className="profile-plot" ref={plotRef}>
              <svg
                ref={svgRef}
                viewBox={`0 0 ${W} ${H}`}
                // Drawn at natural size — 1 unit is 1 pt — rather than stretched to fit, so a
                // label stays the same physical size whatever the window does. The width was
                // measured from this container, so it already fills it. These attributes also
                // carry the size into an exported file, which has none of the page's CSS.
                width={`${W}pt`}
                height={`${H}pt`}
                fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
                style={{ cursor: panning ? 'grabbing' : view ? 'grab' : 'default' }}
                // Panning starts on the background only. The edge handles stop propagation on
                // pointerdown, so grabbing one still drags the boundary rather than the view.
                onPointerDown={(e) => {
                  if (view) setPanning({ clientX: e.clientX, from });
                }}
                onMouseMove={(e) => {
                  const r = residueAt(e.clientX);
                  setHover(r);
                  if (drag && r !== null) setDrag({ ...drag, at: r });
                  if (panning && svgRef.current) {
                    const box = svgRef.current.getBoundingClientRect();
                    const perPx = span / ((innerW / W) * box.width);
                    panBy(Math.round((panning.clientX - e.clientX) * perPx) - (from - panning.from));
                  }
                }}
                onMouseLeave={() => {
                  setHover(null);
                  setPanning(null);
                }}
                onPointerUp={() => {
                  if (drag) commitDrag(drag.region, drag.edge, drag.at);
                  setDrag(null);
                  setPanning(null);
                }}
              >
                {/* residue gridlines through both plots — the trace from a bar to its number */}
                {ticks.map((r) => (
                  <line key={`g${r}`} x1={x0(r)} y1={COV_TOP} x2={x0(r)} y2={TERM_BOT} stroke={GRID} strokeWidth={1} />
                ))}

                {/* cluster bands, behind the data, with a draggable handle on each edge */}
                {config.highlightRegions.map((region, i) => {
                  const live = drag?.region === i;
                  const lo = Math.min(live && drag.edge === 0 ? drag.at : region[0], live && drag.edge === 1 ? drag.at : region[1]);
                  const hi = Math.max(live && drag.edge === 0 ? drag.at : region[0], live && drag.edge === 1 ? drag.at : region[1]);
                  if (hi < from || lo > to) return null; // scrolled out of view
                  // The band is clipped to the visible stretch, but each handle is only drawn
                  // where the real edge is — otherwise dragging the clipped end would silently
                  // move the boundary to wherever the view happens to be cut.
                  const a = x0(Math.max(lo, from));
                  const b = x0(Math.min(hi, to) + 1);
                  const colour = (config.highlightColors ?? [])[i] ?? '#334155';
                  const name = ((config.highlightLabels ?? [])[i] ?? '').trim();
                  return (
                    <g key={i}>
                      <rect x={a} y={COV_TOP} width={Math.max(1, b - a)} height={TERM_BOT - COV_TOP}
                        fill={colour} opacity={live ? 0.16 : 0.08} />
                      {name && (
                        <text x={(a + b) / 2} y={COV_TOP + 10} textAnchor="middle" fontSize={10} fill={colour}>
                          {name}
                        </text>
                      )}
                      {([0, 1] as const).map((edge) => {
                        const res = edge === 0 ? lo : hi;
                        if (res < from || res > to) return null;
                        const x = edge === 0 ? x0(lo) : x0(hi + 1);
                        return (
                          <g key={edge} style={{ cursor: 'ew-resize' }}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              (e.target as Element).releasePointerCapture?.(e.pointerId);
                              setDrag({ region: i, edge, at: edge === 0 ? region[0] : region[1] });
                            }}>
                            <line x1={x} y1={COV_TOP} x2={x} y2={TERM_BOT} stroke={colour}
                              strokeWidth={live ? 2 : 1.25} opacity={0.9} />
                            {/* a wide invisible grab target — the visible rule is too thin to hit */}
                            <rect data-ui-only="1" x={x - 5} y={COV_TOP} width={10} height={TERM_BOT - COV_TOP} fill="transparent" />
                          </g>
                        );
                      })}
                    </g>
                  );
                })}

                {/* coverage */}
                <polygon points={`${x0(from).toFixed(1)},${COV_BOT} ${covPts.join(' ')} ${x0(to).toFixed(1)},${COV_BOT}`} fill={COV} opacity={0.1} />
                <polyline points={covPts.join(' ')} fill="none" stroke={COV} strokeWidth={2} strokeLinejoin="round" />
                {covTicks.map((v) => (
                  <text key={`cy${v}`} x={ML - 7} y={covY(v) + 3.5} textAnchor="end" fontSize={10} fill={MUTED}>
                    {v.toLocaleString('en-US')}
                  </text>
                ))}
                <line x1={ML} y1={COV_BOT} x2={W - MR} y2={COV_BOT} stroke={AXIS} strokeWidth={1} />
                {/* Set vertically, clear of the tick column — laid flat at the top it collided
                    with the topmost tick, which sits at exactly the same height. */}
                <text x={14} y={(COV_TOP + COV_BOT) / 2} textAnchor="middle" fontSize={10} fill={MUTED}
                  transform={`rotate(-90 14 ${(COV_TOP + COV_BOT) / 2})`}>peptide count</text>

                {/* --- residue scale, between the plots so it sits beside the bars --- */}
                {minor.map((r) => (
                  <line key={`m${r}`} x1={x0(r)} y1={COV_BOT} x2={x0(r)} y2={COV_BOT + 4} stroke={AXIS} strokeWidth={1} />
                ))}
                {ticks.map((r) => (
                  <g key={`t${r}`}>
                    <line x1={x0(r)} y1={COV_BOT} x2={x0(r)} y2={COV_BOT + 6} stroke={AXIS} strokeWidth={1} />
                    <text x={x0(r)} y={COV_BOT + 18} textAnchor="middle" fontSize={11} fill={INK}>{r}</text>
                    <line x1={x0(r)} y1={TERM_TOP - 6} x2={x0(r)} y2={TERM_TOP} stroke={AXIS} strokeWidth={1} />
                  </g>
                ))}

                {/* termini */}
                {bars.map((b) => (
                  <g key={b.res}>
                    {b.starts > 0 && (
                      <rect x={x0(b.res)} y={upY(b.starts)} width={barW} height={TERM_MID - upY(b.starts)}
                        fill={START} opacity={b.sa ? 1 : 0.3} rx={1} />
                    )}
                    {b.ends > 0 && (
                      <rect x={x0(b.res)} y={TERM_MID} width={barW} height={dnY(b.ends) - TERM_MID}
                        fill={END} opacity={b.ea ? 1 : 0.3} rx={1} />
                    )}
                  </g>
                ))}
                <polyline points={thr(prof.avgStarts, upY)} fill="none" stroke={INK} strokeWidth={1.4} opacity={0.75} />
                <polyline points={thr(prof.avgEnds, dnY)} fill="none" stroke={INK} strokeWidth={1.4} opacity={0.75} />
                <line x1={ML} y1={TERM_MID} x2={W - MR} y2={TERM_MID} stroke={AXIS} strokeWidth={1} />
                {termTicks.map((v) => (
                  <g key={`ty${v}`}>
                    <text x={ML - 7} y={upY(v) + 3.5} textAnchor="end" fontSize={10} fill={MUTED}>{v}</text>
                    <text x={ML - 7} y={dnY(v) + 3.5} textAnchor="end" fontSize={10} fill={MUTED}>{v}</text>
                  </g>
                ))}
                <text x={14} y={(TERM_TOP + TERM_MID) / 2} textAnchor="middle" fontSize={10} fill={MUTED}
                  transform={`rotate(-90 14 ${(TERM_TOP + TERM_MID) / 2})`}>N-termini</text>
                <text x={14} y={(TERM_MID + TERM_BOT) / 2} textAnchor="middle" fontSize={10} fill={MUTED}
                  transform={`rotate(-90 14 ${(TERM_MID + TERM_BOT) / 2})`}>C-termini</text>

                {/* bottom residue scale */}
                {ticks.map((r) => (
                  <g key={`b${r}`}>
                    <line x1={x0(r)} y1={TERM_BOT} x2={x0(r)} y2={TERM_BOT + 5} stroke={AXIS} strokeWidth={1} />
                    <text x={x0(r)} y={TERM_BOT + 17} textAnchor="middle" fontSize={11} fill={INK}>{r}</text>
                  </g>
                ))}

                {/* --- marked-region summary, part of the plot so it exports with it --- */}
                {summary.length > 0 && (() => {
                  const rows = sortedSummary;
                  const widths = COLS.map(([, share]) => share * innerW);
                  const xs: number[] = [];
                  let acc = ML;
                  for (const w of widths) {
                    xs.push(acc);
                    acc += w;
                  }
                  const headY = TABLE_TOP + TABLE_TITLE;
                  const cell = (ci: number, text: string, y: number, fill: string, weight?: string) => {
                    const [, , right] = COLS[ci];
                    const w = widths[ci];
                    // The first column carries a colour swatch, so its text starts clear of it.
                    const indent = ci === 0 ? 13 : 0;
                    return (
                      <text
                        key={`${ci}-${y}`}
                        x={right ? xs[ci] + w - 8 : xs[ci] + indent}
                        y={y}
                        textAnchor={right ? 'end' : 'start'}
                        fontSize={10.5}
                        fontWeight={weight}
                        fill={fill}
                      >
                        {text}
                      </text>
                    );
                  };
                  return (
                    <g>
                      <text x={ML} y={TABLE_TOP + 14} fontSize={12} fontWeight={600} fill={INK}>
                        Marked regions
                      </text>
                      {COLS.map(([label], ci) => {
                        const on = sort?.col === ci;
                        return (
                          <g
                            key={`h${ci}`}
                            style={{ cursor: 'pointer' }}
                            onClick={() => toggleSort(ci)}
                            // Otherwise a click on a heading is also a grab on the plot behind it
                            // and the view starts panning, exactly as the edge handles avoid.
                            onPointerDown={(e) => e.stopPropagation()}
                          >
                            {/* An invisible target so the whole heading cell is clickable, not
                                just the glyphs. It exports as nothing, having no paint. */}
                            <rect x={xs[ci]} y={headY - 11} width={widths[ci]} height={15} fill="transparent" />
                            {cell(ci, on ? `${label} ${sort!.dir === 1 ? '↑' : '↓'}` : label, headY, on ? INK : MUTED, on ? '600' : undefined)}
                          </g>
                        );
                      })}
                      <line x1={ML} y1={headY + 5} x2={W - MR} y2={headY + 5} stroke={AXIS} strokeWidth={1} />
                      {rows.map((r, ri) => {
                        const y = headY + 5 + (ri + 1) * TABLE_ROW;
                        const money = (v: number) => formatNumber(v, config.notation, 1);
                        return (
                          <g key={ri}>
                            <rect x={ML} y={y - 9} width={8} height={8} rx={2} fill={r.colour} />
                            {cell(0, r.label, y, INK, '600')}
                            {cell(1, `${r.start}–${r.end}`, y, INK)}
                            {cell(2, `${r.end - r.start + 1} aa`, y, INK)}
                            {cell(3, String(r.peptideCount), y, INK)}
                            {cell(4, String(r.nTerminalCleavage), y, INK)}
                            {cell(5, String(r.cTerminalCleavage), y, INK)}
                            {cell(6, money(r.minIntensity), y, INK)}
                            {/* The marker warns that the mean would have been misleading here,
                                which is the whole reason the median is the column shown. */}
                            {cell(7, `${money(r.medianIntensity)}${r.skew >= SKEW_FLAG ? ' ▲' : ''}`, y, INK)}
                            {cell(8, money(r.maxIntensity), y, INK)}
                            <line x1={ML} y1={y + 5} x2={W - MR} y2={y + 5} stroke={GRID} strokeWidth={1} />
                          </g>
                        );
                      })}
                      {anySkewed && (
                        <text
                          x={ML}
                          y={headY + 5 + summary.length * TABLE_ROW + 13}
                          fontSize={9.5}
                          fill={MUTED}
                        >
                          ▲ right-skewed — a few strong peptides carry the region, so the mean
                          would sit well above the typical peptide
                        </text>
                      )}
                    </g>
                  );
                })()}

                {/* --- peptides per time point, for the regions drawn across every track --- */}
                {spanRows.length > 0 && (() => {
                  const cols = config.intensityCols;
                  // The region name keeps a fixed share; the time points split what is left
                  // evenly, so the columns stay aligned however many time points there are.
                  const nameW = innerW * 0.24;
                  const totalW = innerW * 0.12;
                  const colW = (innerW - nameW - totalW) / Math.max(1, cols.length);
                  const xOf = (ci: number) => ML + nameW + ci * colW;
                  const headY = timeTop + TABLE_TITLE;
                  const num = (text: string, x: number, y: number, fill: string, weight?: string, key?: string) => (
                    <text key={key} x={x} y={y} textAnchor="end" fontSize={10.5} fontWeight={weight} fill={fill}>
                      {text}
                    </text>
                  );
                  return (
                    <g>
                      <text x={ML} y={timeTop + 14} fontSize={12} fontWeight={600} fill={INK}>
                        Peptides per time point
                      </text>
                      {/* Says which regions are in this table and why the others are not, so the
                          two tables having different row counts never reads as a bug. */}
                      <text x={ML + 152} y={timeTop + 14} fontSize={9.5} fill={MUTED}>
                        regions spanning all time points
                      </text>
                      {cols.map((col, ci) => (
                        <text key={col} x={xOf(ci) + colW - 8} y={headY} textAnchor="end" fontSize={10.5} fill={MUTED}>
                          {timeLabel(col)}
                        </text>
                      ))}
                      {num('All', W - MR - 8, headY, MUTED)}
                      <line x1={ML} y1={headY + 5} x2={W - MR} y2={headY + 5} stroke={AXIS} strokeWidth={1} />
                      {spanRows.map((r, ri) => {
                        const y = headY + 5 + (ri + 1) * TABLE_ROW;
                        return (
                          <g key={`${r.start}-${r.end}-${ri}`}>
                            <rect x={ML} y={y - 9} width={8} height={8} rx={2} fill={r.colour} />
                            <text x={ML + 13} y={y} fontSize={10.5} fontWeight="600" fill={INK}>
                              {r.label}
                            </text>
                            {cols.map((col, ci) => {
                              const n = r.perColumn[ci] ?? 0;
                              // A time point the region is absent from is a result, not a gap:
                              // greyed rather than blank so it cannot be read as missing data.
                              return num(String(n), xOf(ci) + colW - 8, y, n ? INK : MUTED, undefined, col);
                            })}
                            {num(String(r.peptideCount), W - MR - 8, y, INK, '600')}
                            <line x1={ML} y1={y + 5} x2={W - MR} y2={y + 5} stroke={GRID} strokeWidth={1} />
                          </g>
                        );
                      })}
                    </g>
                  );
                })()}

                {/* crosshair: names the residue under the pointer, in both scales */}
                {hover !== null && hover >= from && hover <= to && (
                  <g pointerEvents="none" data-ui-only="1">
                    <line x1={x0(hover)} y1={COV_TOP} x2={x0(hover)} y2={TERM_BOT} stroke={MUTED} strokeWidth={1} opacity={0.75} />
                    <rect x={x0(hover) - 26} y={COV_BOT + 5} width={52} height={19} rx={3} fill={INK} />
                    <text x={x0(hover)} y={COV_BOT + 18} textAnchor="middle" fontSize={11} fill="#fff">
                      {hover}
                      {proteinSeq[hover - 1] ? ` ${proteinSeq[hover - 1]}` : ''}
                    </text>
                  </g>
                )}
              </svg>
            </div>

            <div className="profile-readout">
              {drag ? (
                <>
                  <b>{(config.highlightLabels ?? [])[drag.region] || `Cluster ${drag.region + 1}`}</b>
                  <span>
                    {drag.edge === 0 ? 'start' : 'end'} → residue <b>{drag.at}</b>
                    {proteinSeq[drag.at - 1] ? ` (${proteinSeq[drag.at - 1]})` : ''}
                  </span>
                  <span style={{ color: START }}>{prof.starts[drag.at]} N-termini here</span>
                  <span style={{ color: END }}>{prof.ends[drag.at]} C-termini here</span>
                  <span className="muted">release to apply</span>
                </>
              ) : hover !== null ? (
                <>
                  <b>Residue {hover}{proteinSeq[hover - 1] ? ` (${proteinSeq[hover - 1]})` : ''}</b>
                  <span>covered by <b>{prof.coverage[hover].toLocaleString('en-US')}</b> peptides</span>
                  <span style={{ color: START }}>
                    <b>{prof.starts[hover]}</b> N-termini (needs {(prof.avgStarts[hover] * config.clusterEnrichmentFactor).toFixed(1)})
                  </span>
                  <span style={{ color: END }}>
                    <b>{prof.ends[hover]}</b> C-termini (needs {(prof.avgEnds[hover] * config.clusterEnrichmentFactor).toFixed(1)})
                  </span>
                  <span>
                    {startAnchor[hover]
                      ? 'Can start a cluster (shared N-terminus)'
                      : endAnchor[hover]
                      ? 'Can start a cluster (shared C-terminus)'
                      : 'Not enough agreement here'}
                  </span>
                </>
              ) : (
                <span className="muted">Move the pointer over the plot to read a residue.</span>
              )}
            </div>
          </>
        );
      })()}
    </section>
  );
}
