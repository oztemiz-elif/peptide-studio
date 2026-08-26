import { describe, expect, it } from 'vitest';
import { assignRows } from './peptides';
import { colorIndex, formatRange, intensityBins, toSuperscript, transformValue } from './intensity';
import { checkOverlap, groupOverlappingRegions, parseIndices, parseHighlightRegions } from './regions';
import { computeIntensityScale, identifyRemovedPeptides, passesFilters } from './filtering';
import { autoResiduesPerRow, buildLayout, cellSize, CENTER_BASELINE_RATIO, leftLabelWidth, pageDimsPt, PT_PER_MM, rowPitch } from './layout';
import { Peptide } from './peptides';
import { defaultConfig } from '../state/config';
import { drawPage, pageCount } from '../render/draw';

describe('assignRows', () => {
  it('packs non-overlapping peptides onto the same row, overlapping onto new rows', () => {
    const rows = assignRows([
      { start: 1, end: 10 },
      { start: 5, end: 15 }, // overlaps {1,10} -> new row
      { start: 20, end: 25 }, // clear of {1,10} -> shares row 0
    ]);
    expect(rows.length).toBe(2);
    expect(rows[0]).toContainEqual({ start: 1, end: 10 });
    expect(rows[0]).toContainEqual({ start: 20, end: 25 });
    expect(rows[1]).toContainEqual({ start: 5, end: 15 });
  });

  it('requires a gap of >1 residue to share a row (matches Python guards)', () => {
    // adjacent (touching) peptides must land on separate rows
    expect(assignRows([{ start: 1, end: 5 }, { start: 6, end: 9 }]).length).toBe(2);
    // a single-residue gap is enough to share
    expect(assignRows([{ start: 1, end: 5 }, { start: 7, end: 9 }]).length).toBe(1);
  });
});

describe('intensity', () => {
  it('linspace bin edges', () => {
    expect(intensityBins(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
  });
  it('colorIndex clamps and digitizes like np.digitize-1', () => {
    const bins = [0, 2, 4, 6, 8, 10];
    expect(colorIndex(0, bins, 5)).toBe(0);
    expect(colorIndex(3, bins, 5)).toBe(1);
    expect(colorIndex(10, bins, 5)).toBe(4); // clamped to last
    expect(colorIndex(100, bins, 5)).toBe(4);
  });
  it('transforms', () => {
    expect(transformValue(8, 'log2')).toBe(3);
    expect(transformValue(1000, 'log10')).toBe(3);
    expect(transformValue(0, 'log2')).toBe(0);
  });
  it('superscript notation', () => {
    expect(toSuperscript(1.25e15)).toBe('1.25 × 10¹⁵');
  });
  it('formatRange integer', () => {
    expect(formatRange(1000, 2000, 'integer')).toBe('1,000 - 2,000');
  });
});

describe('regions', () => {
  it('checkOverlap', () => {
    expect(checkOverlap([1, 5], [4, 8])).toBe(true);
    expect(checkOverlap([1, 5], [6, 8])).toBe(false);
  });
  it('groups overlapping regions to separate groups', () => {
    const g = groupOverlappingRegions([
      [1, 10],
      [5, 15],
      [20, 25],
    ]);
    expect(g.length).toBe(2);
    expect(g[0]).toContainEqual([1, 10]);
    expect(g[0]).toContainEqual([20, 25]);
    expect(g[1]).toContainEqual([5, 15]);
  });
  it('parseIndices handles ranges and singles', () => {
    expect(parseIndices('1,3,5-7,10')).toEqual([1, 3, 5, 6, 7, 10]);
  });
  it('parseHighlightRegions', () => {
    expect(parseHighlightRegions('10-20, 30-40')).toEqual([
      [10, 20],
      [30, 40],
    ]);
  });
});

const peptides: Peptide[] = [
  { start: 1, end: 10, intensity: { t0: 1000, t1: 5000 } },
  { start: 5, end: 8, intensity: { t0: 200, t1: 0 } }, // length 4
  { start: 12, end: 30, intensity: { t0: 9000, t1: 100 } },
];

describe('filtering', () => {
  it('derives min/max from data when not set', () => {
    const cfg = { ...defaultConfig(), intensityCols: ['t0', 't1'] };
    const scale = computeIntensityScale(peptides, ['t0', 't1'], cfg);
    expect(scale.maxRaw).toBe(9000);
    expect(scale.minRaw).toBe(100);
    expect(scale.minUserSet).toBe(false);
  });

  it('length filter removes short peptides', () => {
    const cfg = { ...defaultConfig(), intensityCols: ['t0', 't1'], minPeptideLength: 5 };
    const scale = computeIntensityScale(peptides, ['t0', 't1'], cfg);
    expect(passesFilters(peptides[1], 't0', cfg, scale)).toBe(false); // length 4
    expect(passesFilters(peptides[0], 't0', cfg, scale)).toBe(true);
  });

  it('zero intensity never shown', () => {
    const cfg = { ...defaultConfig(), intensityCols: ['t0', 't1'] };
    const scale = computeIntensityScale(peptides, ['t0', 't1'], cfg);
    expect(passesFilters(peptides[1], 't1', cfg, scale)).toBe(false); // t1 = 0
  });

  it('user min intensity removes below-threshold and reports it', () => {
    const cfg = { ...defaultConfig(), intensityCols: ['t0', 't1'], minIntensity: 1000 };
    const scale = computeIntensityScale(peptides, ['t0', 't1'], cfg);
    const removed = identifyRemovedPeptides(peptides, '', ['t0', 't1'], cfg, scale);
    const short = removed.find((r) => r.start === 5);
    expect(short?.byTimepoint.some((t) => t.reasons.some((x) => x.includes('Below min')))).toBe(true);
  });
});

describe('layout', () => {
  const seq = 'ACDEFGHIKLMNPQRSTVWYACDEFGHIKL'; // 30 aa
  it('wraps a sequence into rows of N residues', () => {
    const cfg = { ...defaultConfig(), intensityCols: ['t0', 't1'] };
    cfg.page.residuesPerRow = 10;
    const { figures } = buildLayout(seq, peptides, cfg, 10);
    expect(figures.length).toBe(1);
    expect(figures[0].rows.length).toBe(3); // 30 / 10
    expect(figures[0].rows[0]).toMatchObject({ startRes: 1, endRes: 10 });
    expect(figures[0].rows[2]).toMatchObject({ startRes: 21, endRes: 30 });
  });

  it('horizontal split produces one figure per time group', () => {
    const cfg = { ...defaultConfig(), intensityCols: ['t0', 't1'], timeGroups: [['t0'], ['t1']] };
    const { figures } = buildLayout(seq, peptides, cfg, 30);
    expect(figures.length).toBe(2);
    expect(figures[0].columns).toEqual(['t0']);
    expect(figures[1].columns).toEqual(['t1']);
  });

  it('split figures share one color scale (consistent colors across figures)', () => {
    const cfg = { ...defaultConfig(), intensityCols: ['t0', 't1'], timeGroups: [['t0'], ['t1']] };
    const { figures } = buildLayout(seq, peptides, cfg, 30);
    expect(figures[0].scale.bins).toEqual(figures[1].scale.bins); // identical bins
  });

  it('orders time-point bands incrementally by numeric time', () => {
    // columns given out of order; bands should come back ascending (t0 before t1)
    const cfg = { ...defaultConfig(), intensityCols: ['t1', 't0'] };
    const { figures } = buildLayout(seq, peptides, cfg, 30);
    const cols = figures[0].rows[0].bands.map((b) => b.col);
    expect(cols).toEqual(['t0', 't1']);
  });

  it('vertical split produces panels for each range', () => {
    const cfg = {
      ...defaultConfig(),
      intensityCols: ['t0'],
      sequenceSplits: [[1, 15] as [number, number], [16, 30] as [number, number]],
    };
    const { figures } = buildLayout(seq, peptides, cfg, 30);
    const panelStarts = figures[0].rows.filter((r) => r.panelStart).length;
    expect(panelStarts).toBe(2);
  });

  it('longest peptide gets row 0 (icicle: top of band)', () => {
    const cfg = { ...defaultConfig(), intensityCols: ['t0'] };
    const ps: Peptide[] = [
      { start: 1, end: 5, intensity: { t0: 100 } },   // length 5
      { start: 1, end: 10, intensity: { t0: 200 } },  // length 10 — longest
    ];
    const { figures } = buildLayout('ACDEFGHIKLMNPQRSTVWYACDEFGHIKL', ps, cfg, 30);
    const cells = figures[0].rows[0].bands[0].cells;
    const long = cells.find((c) => c.id === '1-10')!;
    const short = cells.find((c) => c.id === '1-5')!;
    expect(long.rowIndex).toBeLessThan(short.rowIndex); // longest nearer the top
  });

  it('keeps a peptide on the same global row across a wrap boundary (continuity)', () => {
    const cfg = { ...defaultConfig(), intensityCols: ['t0'] };
    cfg.page.residuesPerRow = 10;
    // peptide 8-13 straddles the 10/11 wrap boundary
    const ps: Peptide[] = [
      { start: 1, end: 10, intensity: { t0: 1000 } },
      { start: 8, end: 13, intensity: { t0: 2000 } },
    ];
    const { figures } = buildLayout(seq, ps, cfg, 10);
    const row0 = figures[0].rows[0].bands.find((b) => b.col === 't0')!;
    const row1 = figures[0].rows[1].bands.find((b) => b.col === 't0')!;
    const a = row0.cells.find((c) => c.id === '8-13')!;
    const b = row1.cells.find((c) => c.id === '8-13')!;
    expect(a.rowIndex).toBe(b.rowIndex); // continuous: same vertical row in both windows
    expect(row0.rowCount).toBe(row1.rowCount); // constant band height across windows
    expect(a.end).toBe(10); // clipped to window 1
    expect(b.start).toBe(11); // clipped to window 2
  });

  it('pageDimsPt resolves orientation and the mm->pt conversion (1in = 25.4mm = 72pt)', () => {
    const portrait = { ...defaultConfig(), page: { ...defaultConfig().page, size: 'A4' as const, orientation: 'portrait' as const } };
    const landscape = { ...defaultConfig(), page: { ...defaultConfig().page, size: 'A4' as const, orientation: 'landscape' as const } };
    const [pw, ph] = pageDimsPt(portrait);
    const [lw, lh] = pageDimsPt(landscape);
    expect(pw).toBeCloseTo(210 * (72 / 25.4), 1); // A4 width in points
    expect(ph).toBeCloseTo(297 * (72 / 25.4), 1);
    expect(pw).toBeLessThan(ph); // portrait: narrower than tall
    expect(lw).toBeGreaterThan(lh); // landscape: wider than tall (swapped)
  });

  it('leftLabelWidth sizes the row-label column to the actual label text, not a fixed count', () => {
    // Short labels ("0.5h", "1h") shouldn't reserve as much space as long ones
    // ("Time point 0.5 hours") — a fixed column count wastes space on the former
    // and clips the latter. The column should track the longest label actually shown.
    const shortLabels = { ...defaultConfig(), intensityCols: ['t0', 't1'], timeLabels: { t0: '0.5h', t1: '1h' } };
    const longLabels = { ...defaultConfig(), intensityCols: ['t0', 't1'], timeLabels: { t0: 'Time point 0.5 hours', t1: 'Time point 1 hour' } };
    expect(leftLabelWidth(longLabels)).toBeGreaterThan(leftLabelWidth(shortLabels));
    // And a figure with short labels should fit visibly more residues per printed row
    // than the fixed-8-column scheme did (it left ~80pt of empty margin for "0.5h").
    const cfg = { ...shortLabels, page: { ...defaultConfig().page, size: 'A4' as const, orientation: 'landscape' as const, margins: 10 } };
    const cell = cellSize(cfg);
    const wasted = 8 * cell - leftLabelWidth(cfg);
    expect(wasted).toBeGreaterThan(0); // the old fixed reservation was wider than these labels need
  });

  it('autoResiduesPerRow fits the printable page width at the configured font size (1:1, no rescale)', () => {
    const base = { ...defaultConfig(), page: { ...defaultConfig().page, size: 'A4' as const, orientation: 'landscape' as const, margins: 10 } };
    const smallFont = { ...base, fontSizes: { ...base.fontSizes, residue: 8 } };
    const bigFont = { ...base, fontSizes: { ...base.fontSizes, residue: 16 } };
    // Larger font -> larger cells -> fewer residues fit across the same physical width.
    expect(autoResiduesPerRow(bigFont)).toBeLessThan(autoResiduesPerRow(smallFont));

    // Cross-check against the formula directly: page width in pt, minus margins and the
    // (label-text-sized, not a fixed column count) left label column, over the cell size.
    const cell = cellSize(smallFont);
    const [wPt] = pageDimsPt(smallFont);
    const printableWPt = wPt - 2 * smallFont.page.margins * (72 / 25.4) - leftLabelWidth(smallFont);
    expect(autoResiduesPerRow(smallFont)).toBe(Math.floor(printableWPt / cell));
  });

  it('autoResiduesPerRow yields fewer residues in portrait than landscape (narrower printable width)', () => {
    const landscape = { ...defaultConfig(), page: { ...defaultConfig().page, size: 'A4' as const, orientation: 'landscape' as const } };
    const portrait = { ...defaultConfig(), page: { ...defaultConfig().page, size: 'A4' as const, orientation: 'portrait' as const } };
    expect(autoResiduesPerRow(portrait)).toBeLessThan(autoResiduesPerRow(landscape));
  });

  it('autoSizeToPage paginates by the real font-derived cell size (larger font -> more page breaks)', () => {
    // Regression guard: the page-height fit must scale with the configured font size.
    // (The previous formula derived an mm-per-cell estimate from residuesPerRow alone,
    // so changing the font size never changed how many rows fit on a page — a bug.)
    const seq = 'A'.repeat(400);
    const ps: Peptide[] = [{ start: 1, end: 400, intensity: { t0: 1000 } }];
    const base = {
      ...defaultConfig(),
      intensityCols: ['t0'],
      page: { ...defaultConfig().page, autoSizeToPage: true, size: 'A4' as const, orientation: 'portrait' as const, margins: 10 },
    };
    const smallFont = { ...base, fontSizes: { ...base.fontSizes, residue: 8 } };
    const bigFont = { ...base, fontSizes: { ...base.fontSizes, residue: 18 } };

    const small = buildLayout(seq, ps, smallFont, 40).figures[0];
    const big = buildLayout(seq, ps, bigFont, 40).figures[0];

    expect(big.pages.length).toBeGreaterThan(small.pages.length);

    // Correctness: every rendered page's physical height must actually fit on the paper,
    // so the browser's print engine never has to slice a page (which would cut a peptide
    // row). This is the exact constraint that prevents the mid-cell cuts.
    const [, hPt] = pageDimsPt(bigFont);
    const printableHPt = hPt - 2 * bigFont.page.margins * PT_PER_MM;
    for (let pi = 0; pi < pageCount(big); pi++) {
      const drawn = drawPage(big, pi, seq, bigFont);
      expect(drawn.height).toBeLessThanOrEqual(printableHPt);
    }
  });

  it('manual page break forces a new page', () => {
    const cfg = { ...defaultConfig(), intensityCols: ['t0'] };
    cfg.page.residuesPerRow = 10;
    cfg.page.rowsPerPage = 100; // would otherwise be a single page
    cfg.page.manualBreaks = [21];
    const { figures } = buildLayout(seq, peptides, cfg, 10);
    expect(figures[0].pages.length).toBeGreaterThanOrEqual(2);
  });

  it('splits a single tall time-point band across pages at clean peptide-row boundaries', () => {
    // Regression guard: a single time point's stack of overlapping peptides (one tall
    // band) used to be unsplittable — if it was taller than the page it rendered one
    // oversized page instead of paginating. It must now break at a peptide-row boundary
    // (never mid-cell) and continue on the next page with the sequence header repeated.
    const shortSeq = 'A'.repeat(20);
    // 12 overlapping peptides in ONE time point -> a single band that is 12 rows tall.
    const ps: Peptide[] = Array.from({ length: 12 }, (_, i) => ({
      start: 1,
      end: 20 - i,
      intensity: { t0: 1000 },
    }));
    const cfg = {
      ...defaultConfig(),
      intensityCols: ['t0'],
      page: {
        ...defaultConfig().page,
        size: 'custom' as const,
        customWidthMm: 100,
        customHeightMm: 30, // forces several rows per page only
        margins: 0,
        autoSizeToPage: true,
      },
    };

    const { figures } = buildLayout(shortSeq, ps, cfg, 20);
    const { rows, pages } = figures[0];

    // One residue window, one band of 12 rows — so any extra pages come from splitting
    // WITHIN that single band, not from row- or band-level breaks.
    expect(rows.length).toBe(1);
    expect(rows[0].bands.length).toBe(1);
    expect(rows[0].bands[0].rowCount).toBe(12);

    const wrapRowsOf = (p: (typeof pages)[number]) => p.columns.flatMap((c) => c.wrapRows);

    expect(pages.length).toBeGreaterThan(1);
    // A later page continues the same wrap-row (header repeated) starting partway down
    // the band — a clean row boundary, not row 0.
    expect(pages.some((p) => wrapRowsOf(p).some((w) => w.continued))).toBe(true);
    expect(pages.some((p) => wrapRowsOf(p).some((w) => w.bands.some((b) => b.rowStart > 0)))).toBe(true);

    // Slices must tile the band's rows exactly once, in order, with no gaps/overlaps.
    const slices = pages.flatMap((p) => wrapRowsOf(p).flatMap((w) => w.bands));
    let expected = 0;
    for (const s of slices) {
      expect(s.rowStart).toBe(expected);
      expect(s.rowEnd).toBeGreaterThan(s.rowStart);
      expected = s.rowEnd;
    }
    expect(expected).toBe(12);
  });

  it("a Q's tail on the sequence row stays clear of the rule under it", () => {
    // Q is the only amino-acid code with a descender, and the sequence row is the one place
    // something heavy is drawn hard against the bottom of the row: the solid rule separating
    // the sequence from the bands, and the outline of a highlight region sitting on it. The
    // tail landed on that rule, ink on ink, and a Q read as an O.
    const seq = 'ACDEFGHIKLMNPQRSTVWYACDEFGHIKL';
    // The 5/0.85 pair is a real published-figure setting, where the cell rounds down to 4 pt
    // and is shorter than the glyph.
    for (const [cellScale, residue] of [[1.4, 10], [1.1, 10], [1.0, 10], [0.85, 5], [0.75, 10]]) {
      const base = defaultConfig();
      const cfg = {
        ...base,
        intensityCols: ['t0'],
        cellScale,
        fontSizes: { ...base.fontSizes, residue },
        highlightRegions: [[12, 16] as [number, number]], // brackets the Q at residue 14
        highlightColors: ['#464646'],
      };
      const at = `residue ${residue} / cellScale ${cellScale}`;
      const { figures } = buildLayout(seq, peptides, cfg, 30);
      const page = drawPage(figures[0], 0, seq, cfg);

      // The rule under the sequence row: the topmost full-width solid black line.
      const rule = page.prims
        .filter((p) => p.k === 'line' && p.stroke === '#000' && p.y1 === p.y2)
        .sort((a, b) => (a.k === 'line' && b.k === 'line' ? a.y1 - b.y1 : 0))[0];
      expect(rule, `no sequence rule at ${at}`).toBeTruthy();
      if (rule?.k !== 'line') throw new Error('unreachable');

      const seqQ = page.prims.find(
        (p) => p.k === 'text' && p.text === 'Q' && p.size === residue && p.y < rule.y1,
      );
      expect(seqQ, `no sequence-row Q at ${at}`).toBeTruthy();
      if (seqQ?.k !== 'text') throw new Error('unreachable');

      // `center: true`, so the drawn baseline sits below the stated y by this much (PrimSvg).
      const baseline = seqQ.y + residue * CENTER_BASELINE_RATIO;
      const tail = baseline + residue * 0.22;
      expect(tail, `tail reaches the rule at ${at}`).toBeLessThan(rule.y1);
      // The highlight outline is boxed to the row, so it has to end below the tail as well.
      const outlines = page.prims.filter((p) => p.k === 'rect' && p.fill === 'none' && p.sw === 1.5);
      expect(outlines.length, `no highlight outline at ${at}`).toBeGreaterThan(0);
      for (const o of outlines) {
        if (o.k !== 'rect') continue;
        expect(tail, `tail reaches an outline at ${at}`).toBeLessThan(o.y + o.h);
      }
    }
  });

  it('leaves the letters themselves exactly where they were', () => {
    // The row grows downward only. Nothing above the baseline moves, so a T's crossbar keeps
    // the clearance from the top of its box that it always had — raising the letters instead
    // would merge that horizontal stroke into the horizontal rule and a T would read as an I.
    const seq = 'ACDEFGHIKLMNPQRSTVWYACDEFGHIKL';
    const base = defaultConfig();
    const cfg = { ...base, intensityCols: ['t0'], cellScale: 0.85, fontSizes: { ...base.fontSizes, residue: 5 } };
    const cell = cellSize(cfg);
    const { figures } = buildLayout(seq, peptides, cfg, 30);
    const page = drawPage(figures[0], 0, seq, cfg);

    let checked = 0;
    for (const p of page.prims) {
      if (p.k !== 'text' || p.size !== 5 || !/^[A-Z]$/.test(p.text)) continue;
      // Centred on a cell-sized box, which is what both the sequence row and a peptide
      // square do — the row growing taller must not have moved either.
      const box = page.prims.find(
        (r) =>
          r.k === 'rect' &&
          Math.abs(r.x + cell / 2 - p.x) < 0.01 &&
          Math.abs(r.h - cell) < 0.01 &&
          Math.abs(r.y + cell * 0.5 - p.y) < 0.01,
      );
      if (!box) continue;
      checked++;
      expect(p.center).toBe(true);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('rowPitch: line style packs rows tighter than the full letter-cell box style', () => {
    const box = { ...defaultConfig(), peptideStyle: 'box' as const };
    const line = { ...defaultConfig(), peptideStyle: 'line' as const, lineThickness: 2 };
    expect(rowPitch(box)).toBe(cellSize(box));
    expect(rowPitch(line)).toBeLessThan(rowPitch(box));
    expect(rowPitch(line)).toBe(line.lineThickness + 3); // thickness + fixed inter-line gap
  });

  it('line style fits more peptide rows in the same wrap-row height (shows more data)', () => {
    // Many mutually-overlapping peptides force many packed rows in one band.
    const ps: Peptide[] = Array.from({ length: 6 }, (_, i) => ({
      start: 1 + i,
      end: 20 + i,
      intensity: { t0: 1000 },
    }));
    const box = { ...defaultConfig(), intensityCols: ['t0'], peptideStyle: 'box' as const };
    const line = { ...defaultConfig(), intensityCols: ['t0'], peptideStyle: 'line' as const, lineThickness: 2 };
    const boxRow = buildLayout(seq, ps, box, 30).figures[0].rows[0];
    const lineRow = buildLayout(seq, ps, line, 30).figures[0].rows[0];
    // Same packing (same rowCount), but the line layout claims less vertical space per row.
    expect(lineRow.bands[0].rowCount).toBe(boxRow.bands[0].rowCount);
    expect(lineRow.heightUnits).toBeLessThan(boxRow.heightUnits);
  });
});
