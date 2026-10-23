import { describe, expect, it } from 'vitest';
import { assignRows } from './peptides';
import { colorIndex, formatRange, intensityBins, toSuperscript, transformValue } from './intensity';
import { checkOverlap, groupOverlappingRegions, inRegion, parseIndices, parseHighlightRegions, SKEW_FLAG, summariseRegions } from './regions';
import { computeIntensityScale, identifyRemovedPeptides, passesFilters } from './filtering';
import { defaultClusterParams, detectClusters } from './clusters';
import { anchorFlags, binSize, buildResidueProfile } from './profile';
import { buildCleavageTable } from './cleavage';
import { autoResiduesPerRow, buildLayout, cellSize, leftLabelWidth, pageDimsPt, PT_PER_MM, rowPitch } from './layout';
import { Peptide } from './peptides';
import { defaultConfig } from '../state/config';
import { CENTER_BASELINE_RATIO, drawPage, inkOnWashes, pageCount } from '../render/draw';

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

describe('highlight fill opacity', () => {
  it('picks white ink only once the fill is genuinely dark', () => {
    expect(inkOnWashes([])).toBe('#000000'); // bare page
    expect(inkOnWashes([['#000000', 0.2]])).toBe('#000000'); // a tint stays black-on-light
    expect(inkOnWashes([['#000000', 1]])).toBe('#ffffff'); // solid black needs white letters
    expect(inkOnWashes([['#ffff00', 1]])).toBe('#000000'); // solid yellow is still light
    expect(inkOnWashes([['#1f77b4', 1]])).toBe('#ffffff'); // a mid blue is dark enough
  });

  it('accounts for overlapping regions stacking up', () => {
    // Neither wash alone darkens the page enough; together they do.
    expect(inkOnWashes([['#000000', 0.4]])).toBe('#000000');
    expect(inkOnWashes([['#000000', 0.4], ['#000000', 0.4]])).toBe('#ffffff');
  });

  it("a Q's tail on the sequence row stays clear of the rule under it", () => {
    // Q is the only amino-acid code with a descender, and the sequence row is the one place
    // something heavy is drawn hard against the bottom of the row: the solid rule separating
    // the sequence from the bands. The tail landed on it, ink on ink, and a Q read as an O.
    const seq = 'ACDEFGHIKLMNPQRSTVWYACDEFGHIKL';
    // The last pair is a real published-figure setting: 5 pt letters packed at 0.85, where the
    // cell rounds down to 4 pt and is shorter than the glyph.
    for (const [cellScale, residue] of [[1.4, 10], [1.1, 10], [1.0, 10], [0.85, 5], [0.75, 10]]) {
      const base = defaultConfig();
      const cfg = {
        ...base,
        intensityCols: ['t0'],
        cellScale,
        fontSizes: { ...base.fontSizes, residue },
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

      // `center: true`, so the drawn baseline is below the stated y by this much (see PrimSvg).
      const baseline = seqQ.y + residue * CENTER_BASELINE_RATIO;
      expect(baseline + residue * 0.22, `tail reaches the rule at ${at}`).toBeLessThan(rule.y1);
      // Any highlight region drawn on this row is boxed to the row, so its outline has to end
      // below the tail too — that outline is the other rule a tail used to disappear into.
      const outlines = page.prims.filter((p) => p.k === 'rect' && p.fill === 'none' && p.sw === 1.5);
      for (const o of outlines) {
        if (o.k !== 'rect') continue;
        expect(baseline + residue * 0.22, `tail reaches an outline at ${at}`).toBeLessThan(o.y + o.h);
      }
    }
  });

  it('leaves the letters themselves exactly where they were', () => {
    // The row grows downward only. Nothing above the baseline moves, so a T's crossbar keeps
    // the clearance from the top of its box that it always had.
    const seq = 'ACDEFGHIKLMNPQRSTVWYACDEFGHIKL';
    const base = defaultConfig();
    const cfg = { ...base, intensityCols: ['t0'], cellScale: 0.85, fontSizes: { ...base.fontSizes, residue: 5 } };
    const cell = cellSize(cfg);
    const { figures } = buildLayout(seq, peptides, cfg, 30);
    const page = drawPage(figures[0], 0, seq, cfg);

    // Every peptide-square letter is centred on its own square, untouched by the row change.
    let checked = 0;
    for (const p of page.prims) {
      if (p.k !== 'text' || p.size !== 5 || !/^[A-Z]$/.test(p.text)) continue;
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

  it('an opaque region does not hide the sequence', () => {
    const cfg = {
      ...defaultConfig(),
      intensityCols: ['t0'],
      highlightRegions: [[2, 5] as [number, number]],
      highlightColors: ['#000000'],
      highlightOpacity: [100],
      highlightSpanAll: [true],
    };
    const seq = 'ACDEFGHIKLMNPQRSTVWYACDEFGHIKL';
    const { figures } = buildLayout(seq, peptides, cfg, 30);
    const page = drawPage(figures[0], 0, seq, cfg);
    // Amino-acid letters only — the ruler also emits single-character text ("5").
    const letters = page.prims.filter((p) => p.k === 'text' && /^[A-Z]$/.test(p.text));
    const wash = page.prims.findIndex((p) => p.k === 'rect' && p.fill === '#000000' && p.opacity === 1);
    const covered = letters.filter((p) => p.k === 'text' && p.fill === '#ffffff');
    // Letters inside the region turned white, and every letter is still painted after the
    // wash — an opaque fill can never bury the sequence.
    expect(covered.length).toBe(4);
    letters.forEach((l) => expect(page.prims.indexOf(l)).toBeGreaterThan(wash));
  });
});

describe('cleavage by bond', () => {
  const seq = 'MAKLSTVRQ'; // 9 residues, so bonds 1-2 .. 8-9
  const p = (start: number, end: number, t: Record<string, number>) => ({ start, end, intensity: t });
  const any = (q: { intensity: Record<string, number> }, col: string) => (q.intensity[col] ?? 0) > 0;

  it('assigns each terminus to the bond it names, not to its own residue', () => {
    // One cut between 4 and 5, seen from both sides: a peptide finishing at 4 and one
    // beginning at 5. They sit on different residues and must land on the same bond.
    const bonds = buildCleavageTable(
      [p(1, 4, { t0: 100 }), p(5, 9, { t0: 100 })],
      seq,
      ['t0'],
      any,
    );
    const at = (p1: number) => bonds.find((b) => b.p1 === p1)!;
    expect(at(4).total).toEqual([2]);
    expect(at(4).fromC).toEqual([1]); // the peptide ending at 4
    expect(at(4).fromN).toEqual([1]); // the peptide starting at 5
    expect(at(4).p1aa).toBe('L');
    expect(at(4).p1PrimeAa).toBe('S');
    // Nothing leaks onto the neighbouring bonds.
    expect(at(3).total).toEqual([0]);
    expect(at(5).total).toEqual([0]);
  });

  it('ignores the protein\'s own termini, which are not cleavages', () => {
    const bonds = buildCleavageTable([p(1, 9, { t0: 100 })], seq, ['t0'], any);
    expect(bonds).toHaveLength(8); // bonds 1-2 .. 8-9, never 0-1 or 9-10
    expect(bonds.every((b) => b.pooledTotal === 0)).toBe(true);
  });

  it('counts per time point, and pools each peptide once', () => {
    const bonds = buildCleavageTable(
      [p(3, 6, { t0: 500, t1: 0 }), p(3, 6, { t0: 0, t1: 900 })],
      seq,
      ['t0', 't1'],
      any,
    );
    const at = (p1: number) => bonds.find((b) => b.p1 === p1)!;
    expect(at(2).total).toEqual([1, 1]); // both peptides begin at 3, one per time point
    expect(at(2).pooledTotal).toBe(2);
    expect(at(6).total).toEqual([1, 1]); // and both finish at 6
    expect(at(6).pooledFromC).toBe(2);
    expect(at(6).pooledFromN).toBe(0);
  });

  it('honours the caller\'s presence test', () => {
    const weak = [p(3, 6, { t0: 50 })];
    const strict = buildCleavageTable(weak, seq, ['t0'], (q, c) => (q.intensity[c] ?? 0) >= 100);
    expect(strict.find((b) => b.p1 === 2)!.total).toEqual([0]);
    expect(strict.find((b) => b.p1 === 2)!.pooledTotal).toBe(1); // pooling never filters
  });
});

describe('region membership', () => {
  // Region 50-70, so 21 residues. Each case names which half of the OR decides it.
  const inHalf = (start: number, end: number) => inRegion({ start, end }, 50, 70, 50);

  it('keeps a peptide that covers most of the region, however far it runs past', () => {
    expect(inHalf(40, 90)).toBe(true); // 21 shared, the whole region, only 41% of the peptide
    expect(inHalf(50, 70)).toBe(true);
  });

  it('keeps a short peptide that sits inside, which can never cover half the region', () => {
    expect(inHalf(60, 64)).toBe(true); // 5 shared: 24% of the region, 100% of the peptide
    expect(inHalf(45, 56)).toBe(true); // 7 shared: 33% of the region, 58% of the peptide
  });

  it('drops a peptide that only clips an edge', () => {
    expect(inHalf(65, 85)).toBe(false); // 6 shared: 29% of the region, 29% of the peptide
    expect(inHalf(30, 52)).toBe(false); // 3 shared
    expect(inHalf(71, 90)).toBe(false); // touching but not overlapping
  });

  it('tightens and loosens with the threshold', () => {
    expect(inRegion({ start: 65, end: 85 }, 50, 70, 25)).toBe(true); // 29% clears 25%
    expect(inRegion({ start: 45, end: 56 }, 50, 70, 60)).toBe(false); // 58% no longer clears 60%
    expect(inRegion({ start: 71, end: 90 }, 50, 70, 1)).toBe(false); // no overlap is never membership
  });
});

describe('marked-region summary', () => {
  const p = (start: number, end: number, t0: number) => ({ start, end, intensity: { t0 } });

  it('counts what is in a region and how each boundary is supported', () => {
    const visible = [
      p(20, 45, 500),        // both boundaries
      p(20, 45, 4_000_000),  // both boundaries
      p(20, 40, 9_000),      // start only
      p(25, 45, 70_000),     // end only
      p(30, 38, 1_200),      // neither, but inside
      p(60, 80, 5_000),      // outside entirely
    ];
    const [r] = summariseRegions([[20, 45]], ['Cluster 1'], ['#123456'], visible, ['t0']);
    expect(r).toMatchObject({ label: 'Cluster 1', start: 20, end: 45, colour: '#123456' });
    expect(r.peptideCount).toBe(5); // everything overlapping, not just the anchored ones
    expect(r.nTerminalCleavage).toBe(3); // peptides starting exactly at 20
    expect(r.cTerminalCleavage).toBe(3); // peptides ending exactly at 45
    expect(r.minIntensity).toBe(500);
    expect(r.maxIntensity).toBe(4_000_000);
  });

  it('takes each peptide at its own strongest time point', () => {
    const visible = [
      { start: 20, end: 40, intensity: { a: 10, b: 800 } },
      { start: 20, end: 40, intensity: { a: 5_000, b: 2 } },
    ];
    const [r] = summariseRegions([[20, 40]], [], [], visible, ['a', 'b']);
    expect(r.minIntensity).toBe(800); // the first peptide's best, not its worst
    expect(r.maxIntensity).toBe(5_000);
  });

  it('reports the median, and flags the region when the mean has run away from it', () => {
    // Four ordinary peptides and one very abundant one — the case the median exists for.
    const visible = [p(20, 40, 1_000), p(20, 40, 2_000), p(20, 40, 3_000), p(20, 40, 4_000), p(20, 40, 990_000)];
    const [r] = summariseRegions([[20, 40]], [], [], visible, ['t0']);
    expect(r.medianIntensity).toBe(3_000);
    expect(r.meanIntensity).toBe(200_000);
    expect(r.skew).toBeGreaterThanOrEqual(SKEW_FLAG);
  });

  it('averages the middle pair when the count is even and leaves even spreads unflagged', () => {
    const visible = [p(20, 40, 100), p(20, 40, 200), p(20, 40, 300), p(20, 40, 400)];
    const [r] = summariseRegions([[20, 40]], [], [], visible, ['t0']);
    expect(r.medianIntensity).toBe(250);
    expect(r.meanIntensity).toBe(250);
    expect(r.skew).toBeLessThan(SKEW_FLAG);
  });

  it('breaks the count down by time point, using the caller\'s idea of present', () => {
    const visible: { start: number; end: number; intensity: Record<string, number> }[] = [
      { start: 20, end: 40, intensity: { a: 500, b: 0 } },   // a only
      { start: 25, end: 35, intensity: { a: 900, b: 700 } }, // both
      { start: 30, end: 38, intensity: { a: 0, b: 60 } },    // b only, and under the threshold
      { start: 80, end: 90, intensity: { a: 400, b: 400 } }, // outside the region
    ];
    const [plain] = summariseRegions([[20, 40]], [], [], visible, ['a', 'b'], [true]);
    expect(plain.perColumn).toEqual([2, 2]); // default: any intensity at all
    expect(plain.spanAll).toBe(true);

    // A filter the figure would apply drops the weak peptide from its time point, and the
    // breakdown has to follow it rather than keep its own count.
    const [filtered] = summariseRegions([[20, 40]], [], [], visible, ['a', 'b'], [], (p, c) => (p.intensity[c] ?? 0) >= 100);
    expect(filtered.perColumn).toEqual([2, 1]);
    expect(filtered.peptideCount).toBe(3); // the pooled count is unchanged
    expect(filtered.spanAll).toBe(false); // no flag given
  });

  it('normalises a reversed range and falls back to a numbered label', () => {
    const [r] = summariseRegions([[45, 20]], [''], [], [p(20, 45, 100)], ['t0']);
    expect(r).toMatchObject({ start: 20, end: 45, label: 'Region 1' });
    expect(r.peptideCount).toBe(1);
  });
});

describe('residue profile', () => {
  const p = (start: number, end: number): Peptide => ({ start, end, intensity: { t0: 1000 } });

  it('counts coverage, starts and ends per residue', () => {
    const prof = buildResidueProfile([p(1, 5), p(3, 8), p(3, 6)], 10, 3);
    expect(prof.coverage[1]).toBe(1);
    expect(prof.coverage[4]).toBe(3);
    expect(prof.coverage[7]).toBe(1);
    expect(prof.coverage[9]).toBe(0);
    expect(prof.starts[3]).toBe(2);
    expect(prof.ends[5]).toBe(1);
    expect(prof.maxCoverage).toBe(3);
    expect(prof.maxTerminus).toBe(2);
  });

  it('clips peptides that run past either end of the sequence', () => {
    const prof = buildResidueProfile([p(-4, 3), p(8, 40)], 10, 3);
    expect(prof.coverage[1]).toBe(1);
    expect(prof.coverage[10]).toBe(1);
    expect(prof.starts.slice(1).reduce((a, b) => a + b, 0)).toBe(1); // the -4 start is off-sequence
  });

  it('local means are windowed, and match a direct calculation', () => {
    const ps = [p(2, 9), p(2, 9), p(5, 9), p(20, 28), p(20, 28), p(20, 28)];
    const prof = buildResidueProfile(ps, 30, 5);
    const direct = (res: number) => {
      let total = 0;
      const lo = Math.max(1, res - 5), hi = Math.min(30, res + 5);
      for (let i = lo; i <= hi; i++) total += prof.starts[i];
      return total / (hi - lo + 1);
    };
    for (const res of [1, 5, 15, 22, 30]) expect(prof.avgStarts[res]).toBeCloseTo(direct(res), 10);
    // A quiet stretch between the two piles has a lower baseline than the piles themselves.
    expect(prof.avgStarts[14]).toBeLessThan(prof.avgStarts[21]);
  });

  it('anchorFlags applies the same test detectClusters does', () => {
    const ps = [
      ...Array.from({ length: 8 }, () => p(20, 40)),
      ...Array.from({ length: 2 }, () => p(60, 80)),
    ];
    const prof = buildResidueProfile(ps, 100, 30);
    const flags = anchorFlags(prof.starts, prof.avgStarts, 100, 3, 2);
    expect(flags[20]).toBe(true);
    expect(flags[60]).toBe(false); // only 2 peptides — under the shared minimum
    const cfg = { ...defaultConfig(), intensityCols: ['t0'] };
    const found = detectClusters(ps, 100, ['t0'], cfg, computeIntensityScale(ps, ['t0'], cfg), {
      ...defaultClusterParams(),
      minSharedPeptides: 3,
      enrichmentFactor: 2,
      maxLength: 30,
    }).clusters;
    expect(found.some((c) => c.anchor === 20)).toBe(true);
    expect(found.some((c) => c.anchor === 60)).toBe(false);
  });

  it('bins only when one bar per residue would be too many nodes', () => {
    expect(binSize(163)).toBe(1);
    expect(binSize(1200)).toBe(1);
    expect(binSize(2400)).toBe(2);
    expect(binSize(34000)).toBe(29);
    // Whatever the protein length, the drawn bar count stays bounded.
    for (const n of [163, 2000, 10000, 34000]) {
      expect(Math.ceil(n / binSize(n))).toBeLessThanOrEqual(1200);
    }
  });
});

describe('cluster detection', () => {
  const seq100 = 'ACDEFGHIKL'.repeat(10); // 100 aa
  const params = { ...defaultClusterParams(), minLength: 8, maxLength: 100, minSharedPeptides: 3 };
  const run = (ps: Peptide[], over: Partial<typeof params> = {}) => {
    const cfg = { ...defaultConfig(), intensityCols: ['t0'] };
    const scale = computeIntensityScale(ps, ['t0'], cfg);
    return detectClusters(ps, seq100.length, ['t0'], cfg, scale, { ...params, ...over }).clusters;
  };
  const pep = (start: number, end: number, intensity = 1000): Peptide => ({ start, end, intensity: { t0: intensity } });
  const many = (n: number, start: number, end: number, intensity = 1000) =>
    Array.from({ length: n }, () => pep(start, end, intensity));
  /** A staircase: `n` peptides all starting at `from`, each one residue shorter. */
  const staircase = (from: number, longest: number, n: number, intensity = 1000): Peptide[] =>
    Array.from({ length: n }, (_, i) => pep(from, longest - i, intensity));

  it('anchors a cluster at a shared start and reports the agreement', () => {
    const found = run([...staircase(20, 50, 6), pep(80, 95)]);
    expect(found.length).toBe(1);
    expect(found[0]).toMatchObject({ start: 20, anchoredOn: 'start', anchor: 20, anchorCount: 6 });
  });

  it('uses a repeated far end when the family agrees on one', () => {
    // 6 of 8 peptides finish at 50 — well over the 40% concentration default.
    const ps = [...many(6, 20, 50), pep(20, 48), pep(20, 46)];
    const [c] = run(ps);
    expect(c).toMatchObject({ start: 20, end: 50, farEdge: 'shared', farCount: 6 });
  });

  it('draws a staircase edge where several members still reach, not at the furthest one', () => {
    // Ends at 50,49,48,47,46,45 — all different, so no position is a second edge. With 3
    // peptides required, the edge is 48: three members (50,49,48) reach that far.
    const [c] = run(staircase(20, 50, 6));
    expect(c).toMatchObject({ start: 20, end: 48, farEdge: 'longest', farCount: 0 });
    // Demanding more support pulls the edge further in; demanding one lets the outlier win.
    expect(run(staircase(20, 50, 6), { minSharedPeptides: 5 })[0].end).toBe(46);
    expect(run(staircase(20, 50, 6), { minSharedPeptides: 1 })[0].end).toBe(50);
  });

  it('one peptide running far beyond its siblings cannot stretch the cluster', () => {
    // Five peptides stop around 45; a single outlier reaches 80.
    const ps = [...many(3, 20, 45), pep(20, 44), pep(20, 43), pep(20, 80)];
    const [c] = run(ps, { concentrationPercent: 90 });
    expect(c.end).toBe(45);
  });

  it('the concentration setting decides which of the two applies', () => {
    // 3 of 9 finish at 50 — 33%. Under a 30% setting that is a second edge, under 40% it is
    // not and the longest member (60) is used instead.
    const ps = [...many(3, 20, 50), ...staircase(20, 60, 6)];
    expect(run(ps, { concentrationPercent: 30 })[0]).toMatchObject({ end: 50, farEdge: 'shared' });
    // Above the bar it falls through to the staircase rule: 60, 59 and 58 are the three
    // furthest ends, so 58 is the last position three members reach.
    expect(run(ps, { concentrationPercent: 40 })[0]).toMatchObject({ end: 58, farEdge: 'longest' });
  });

  it('chooses the edge among members that fit, never a cut at the maximum length', () => {
    // Members end at 54,53,52,51,50,49,48,47.
    const ps = staircase(20, 54, 8);
    // Max 40: everything fits, so the edge is the third furthest end, 52.
    expect(run(ps, { maxLength: 40 })[0]).toMatchObject({ start: 20, end: 52, farEdge: 'longest' });
    // Max 32: only 47..51 fit, so the edge is the third furthest of those, 49.
    expect(run(ps, { maxLength: 32 })[0]).toMatchObject({ start: 20, end: 49, farEdge: 'longest' });
    // Every edge is a real peptide terminus, never the limit itself.
    for (const max of [32, 34, 36, 40]) {
      const c = run(ps, { maxLength: max })[0];
      expect(ps.some((p) => p.end === c.end)).toBe(true);
    }
  });

  it('falls back to the limit only when no member fits at all', () => {
    // Every peptide runs 41 residues, so with a maximum of 32 there is no terminus to land on.
    const [c] = run(many(6, 20, 60), { maxLength: 32 });
    expect(c).toMatchObject({ start: 20, end: 51, farEdge: 'capped' });
    expect(c.end - c.start + 1).toBe(32);
  });

  it('a shared far end beyond the maximum length does not drag the cluster out', () => {
    // 6 peptides agree on ending at 70 (51 aa) — too far. The edge comes from the members
    // that do fit, whose own agreement is at 45.
    const ps = [...many(6, 20, 70), ...many(4, 20, 45), pep(20, 40)];
    const [c] = run(ps, { maxLength: 30 });
    expect(c).toMatchObject({ start: 20, end: 45, farEdge: 'shared', farCount: 4 });
  });

  it('finds families anchored at their end, not only at their start', () => {
    // Ragged starts, every peptide finishing at 60: the mirror image of a staircase.
    const ps = Array.from({ length: 6 }, (_, i) => pep(20 + i, 60));
    const [c] = run(ps);
    expect(c).toMatchObject({ anchoredOn: 'end', anchor: 60, end: 60, anchorCount: 6 });
    // Starts are 20..25; three members reach back as far as 22, so that is the edge.
    expect(c.start).toBe(22);
  });

  it('a position must stand out against its own neighbourhood', () => {
    // Peptide starts spread evenly along the whole protein: every position is shared by 3
    // peptides, but none stands out, so nothing anchors.
    const flat: Peptide[] = [];
    for (let s = 1; s <= 78; s++) flat.push(...many(3, s, s + 20));
    expect(run(flat, { maxLength: 30 }).length).toBe(0);
    expect(run(flat, { maxLength: 30, enrichmentFactor: 0 }).length).toBeGreaterThan(0);

    // The same data with one position carrying far more than its neighbours does anchor.
    const withPeak = [...flat, ...many(30, 40, 62)];
    const found = run(withPeak, { maxLength: 30 });
    expect(found.some((c) => c.anchor === 40)).toBe(true);
  });

  it('a strong cluster elsewhere cannot hide a weaker one', () => {
    // A 60-peptide family at 20 and a 4-peptide family at 70. The second is 15x smaller, the
    // sort of gap that made a "% of the protein maximum" threshold discard it.
    const ps = [...many(60, 20, 45), ...many(4, 70, 92)];
    const found = run(ps);
    expect(found.length).toBe(2);
    expect(found.map((c) => c.start)).toEqual([20, 70]);
  });

  it('merges a derived sub-cluster into its parent by default', () => {
    // 20-70 trimmed back to 20-45: same start, much shorter, so the same species trimmed.
    const ps = [...many(8, 20, 70), ...many(6, 20, 45)];
    const merged = run(ps);
    expect(merged.length).toBe(1);
    expect(merged[0]).toMatchObject({ start: 20, end: 70, parent: null });
  });

  it('keeps derived sub-clusters separately when asked', () => {
    const ps = [...many(8, 20, 70), ...many(6, 20, 45)];
    const found = run(ps, { hierarchical: true });
    expect(found.length).toBe(2);
    const child = found.find((c) => c.end === 45)!;
    const parentIdx = found.findIndex((c) => c.end === 70);
    expect(child.parent).toBe(parentIdx);
  });

  it('treats both halves of a cleaved parent as derived from it', () => {
    // 20-70 cleaved into 20-45 and 46-70. The halves share no residue with each other, but
    // each shares a terminus with the parent, so nothing based on overlap alone would link
    // them and this does.
    const ps = [...many(8, 20, 70), ...many(5, 20, 45), ...many(5, 46, 70)];
    const merged = run(ps);
    expect(merged.length).toBe(1);
    expect(merged[0]).toMatchObject({ start: 20, end: 70 });
    expect(run(ps, { hierarchical: true }).length).toBe(3);
  });

  it('never reports a cluster wholly inside another, even sharing no terminus', () => {
    // 30-45 sits in the middle of 20-70, touching neither of its edges — so it is neither a
    // near-duplicate (far too short) nor a trimmed child, and used to survive both rules.
    const ps = [...many(8, 20, 70), ...many(6, 30, 45)];
    const merged = run(ps);
    expect(merged.length).toBe(1);
    expect(merged[0]).toMatchObject({ start: 20, end: 70 });
    // Turning nesting on is the only way to see it.
    expect(run(ps, { hierarchical: true }).length).toBe(2);
  });

  it('keeps the better-supported cluster when one contains the other', () => {
    // The inner cluster has far more peptides behind it, so the weak container goes instead.
    const ps = [...many(4, 20, 70), ...many(40, 30, 45)];
    const found = run(ps);
    expect(found.length).toBe(1);
    expect(found[0]).toMatchObject({ start: 30, end: 45 });
  });

  it('does not weld together neighbours that share no terminus', () => {
    const ps = [...many(6, 20, 45), ...many(6, 50, 80)];
    const found = run(ps);
    expect(found.length).toBe(2);
    expect(found.map((c) => [c.start, c.end])).toEqual([[20, 45], [50, 80]]);
  });

  it('drops near-duplicates but keeps clusters that finish in different places', () => {
    // Same span give or take two residues: one finding reported twice.
    const dup = [...many(8, 20, 50), ...many(5, 22, 52)];
    expect(run(dup).length).toBe(1);
    // Starting close together but finishing 20 residues apart: two findings.
    const distinct = [...many(8, 20, 40), ...many(5, 24, 60)];
    const found = run(distinct);
    expect(found.length).toBe(2);
    expect(found.map((c) => [c.start, c.end])).toEqual([[20, 40], [24, 60]]);
  });

  it('respects the minimum length', () => {
    const short = many(6, 20, 24); // 5 aa
    expect(run(short).length).toBe(0);
    expect(run(short, { minLength: 4 }).length).toBe(1);
  });

  it('only counts peptides that pass the active filters', () => {
    const ps = staircase(20, 50, 6);
    const cfg = { ...defaultConfig(), intensityCols: ['t0'], minPeptideLength: 40 };
    const scale = computeIntensityScale(ps, ['t0'], cfg);
    expect(detectClusters(ps, seq100.length, ['t0'], cfg, scale, params).clusters.length).toBe(0);
  });

  it('intensity never decides what is a cluster, only what gets reported', () => {
    const ps = [...many(6, 10, 40, 10), ...many(6, 60, 90, 1_000_000)];
    const found = run(ps);
    expect(found.length).toBe(2);
    expect(found[0].maxIntensity).toBe(10);
    expect(found[1].maxIntensity).toBe(1_000_000);
  });

  it('reports the weakest and strongest peptide in each cluster', () => {
    // One family spanning three orders of magnitude, each peptide at its own strongest point.
    const ps = [pep(20, 45, 500), pep(20, 45, 90_000), pep(20, 45, 4_000_000), pep(20, 43, 7_000)];
    const [c] = run(ps);
    expect(c.peptideCount).toBe(4);
    expect(c.minIntensity).toBe(500);
    expect(c.maxIntensity).toBe(4_000_000);
  });

  it('counts every peptide overlapping the cluster, not just its family', () => {
    // 6 anchored at 20, plus one unrelated peptide that merely overlaps the range.
    const ps = [...many(6, 20, 45), pep(30, 50)];
    const [c] = run(ps);
    expect(c.anchorCount).toBe(6); // peptides sharing the anchor
    expect(c.peptideCount).toBe(7); // peptides present in the region
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

  it('a span-all highlight region is marked down through every time-point band', () => {
    const base = { ...defaultConfig(), intensityCols: ['t0', 't1'], highlightRegions: [[5, 8] as [number, number]], highlightColors: ['#ff0000'] };
    const short = { ...base, highlightSpanAll: [false] };
    const tall = { ...base, highlightSpanAll: [true] };
    // A region is marked by its two vertical edges — no top, no bottom — so the geometry is
    // read off the pair of lines rather than off a box.
    const edges = (cfg: typeof base) => {
      const { figures } = buildLayout(seq, peptides, cfg, 30);
      const page = drawPage(figures[0], 0, seq, cfg);
      const lines = page.prims.filter((p) => p.k === 'line' && p.stroke === '#ff0000') as Extract<
        typeof page.prims[number],
        { k: 'line' }
      >[];
      expect(lines.length).toBe(2); // first residue and last residue, and nothing else
      expect(lines.every((l) => l.x1 === l.x2)).toBe(true); // both vertical
      expect(lines[0].y1).toBe(lines[1].y1);
      expect(lines[0].y2).toBe(lines[1].y2);
      return { left: lines[0], right: lines[1] };
    };
    const s = edges(short);
    const t = edges(tall);
    expect(t.right.x1 - t.left.x1).toBe(s.right.x1 - s.left.x1); // same residue span
    expect(t.left.y1).toBe(s.left.y1); // both start at the reference-sequence row
    // The tall pair reaches past the sequence row and down over the peptide bands.
    expect(t.left.y2).toBeGreaterThan(s.left.y2 + rowPitch(tall));
    // The tinted background spans the same rectangle those edges bound, and is painted behind
    // the residue letters, the gridlines and every peptide cell rather than over them.
    const page = (() => {
      const { figures } = buildLayout(seq, peptides, tall, 30);
      return drawPage(figures[0], 0, seq, tall);
    })();
    const washIdx = page.prims.findIndex((p) => p.k === 'rect' && p.fill === '#ff0000');
    const wash = page.prims[washIdx] as Extract<typeof page.prims[number], { k: 'rect' }>;
    expect(wash.y).toBe(t.left.y1);
    expect(wash.y + wash.h).toBe(t.left.y2);
    expect(wash.opacity).toBeLessThan(0.5); // a tint, not a veil
    const firstLetter = page.prims.findIndex((p) => p.k === 'text' && p.text === seq[0]);
    const firstPeptideCell = page.prims.findIndex((p) => p.k === 'rect' && p.opacity === 0.7);
    expect(washIdx).toBeLessThan(firstLetter);
    expect(washIdx).toBeLessThan(firstPeptideCell);
  });

  it('grows the ruler ticks to span whatever gap the annotations open', () => {
    const ticks = (extra: Partial<typeof base>) => {
      const base = { ...defaultConfig(), intensityCols: ['t0'] };
      const cfg = { ...base, ...extra };
      const { figures } = buildLayout(seq, peptides, cfg, 30);
      const page = drawPage(figures[0], 0, seq, cfg);
      const grey = page.prims.filter(
        (p) => p.k === 'line' && p.stroke === '#555' && p.x1 === p.x2,
      ) as Extract<typeof page.prims[number], { k: 'line' }>[];
      expect(grey.length).toBeGreaterThan(0);
      const letter = page.prims.find((p) => p.k === 'text' && p.text === seq[0]);
      if (letter?.k !== 'text') throw new Error('no sequence letter drawn');
      return { len: grey[0].y2 - grey[0].y1, bottom: grey[0].y2, seqTop: letter.y };
    };
    const base = { ...defaultConfig(), intensityCols: ['t0'] };

    const plain = ticks({});
    const framed = ticks({
      highlightRegions: [[5, 8] as [number, number]],
      highlightColors: ['#ff0000'],
    });
    const bracketed = ticks({
      highlightRegions: [[5, 8] as [number, number]],
      highlightColors: ['#ff0000'],
      highlightBracket: [true],
    });

    // Unannotated figures keep the tick they always had; a gap lengthens it.
    expect(plain.len).toBe(2);
    expect(framed.len).toBeGreaterThan(plain.len);
    expect(bracketed.len).toBeGreaterThan(plain.len);
    // However long it gets, it never runs into the letters.
    for (const t of [plain, framed, bracketed]) expect(t.bottom).toBeLessThanOrEqual(t.seqTop);
  });

  it('marks a bracketed region above the sequence instead of beside it', () => {
    const cfg = {
      ...defaultConfig(),
      intensityCols: ['t0'],
      highlightRegions: [[5, 8] as [number, number]],
      highlightColors: ['#ff0000'],
      highlightBracket: [true],
    };
    const { figures } = buildLayout(seq, peptides, cfg, 30);
    const page = drawPage(figures[0], 0, seq, cfg);
    const lines = page.prims.filter((p) => p.k === 'line' && p.stroke === '#ff0000') as Extract<
      typeof page.prims[number],
      { k: 'line' }
    >[];
    // A rule plus one leg at each end — and no vertical edges running down beside the letters.
    expect(lines.length).toBe(3);
    const rule = lines.find((l) => l.y1 === l.y2)!;
    const legs = lines.filter((l) => l.x1 === l.x2);
    expect(legs.length).toBe(2);
    expect(rule.x1).toBe(legs[0].x1); // the legs stand at the rule's two ends
    expect(rule.x2).toBe(legs[1].x1);
    expect(legs.every((l) => l.y1 === rule.y1 && l.y2 > rule.y1)).toBe(true); // turning down

    const letter = page.prims.find((p) => p.k === 'text' && p.text === seq[4]);
    if (letter?.k !== 'text') throw new Error('no sequence letter drawn');
    expect(rule.y1).toBeLessThan(letter.y); // above the sequence
    // The wash is still painted behind the letters, spanning exactly the bracketed residues.
    const wash = page.prims.find((p) => p.k === 'rect' && p.fill === '#ff0000');
    if (wash?.k !== 'rect') throw new Error('no wash drawn');
    expect(wash.x).toBe(rule.x1);
    expect(wash.x + wash.w).toBe(rule.x2);
    expect(wash.y).toBeGreaterThan(rule.y1);
  });

  it('stacks overlapping brackets on their own levels', () => {
    const bracketed = (regions: [number, number][]) => {
      const cfg = {
        ...defaultConfig(),
        intensityCols: ['t0'],
        highlightRegions: regions,
        highlightColors: regions.map(() => '#ff0000'),
        highlightBracket: regions.map(() => true),
      };
      const { figures } = buildLayout(seq, peptides, cfg, 30);
      const page = drawPage(figures[0], 0, seq, cfg);
      const rules = page.prims.filter(
        (p) => p.k === 'line' && p.stroke === '#ff0000' && p.y1 === p.y2,
      ) as Extract<typeof page.prims[number], { k: 'line' }>[];
      const letter = page.prims.find((p) => p.k === 'text' && p.text === seq[0]);
      if (letter?.k !== 'text') throw new Error('no sequence letter drawn');
      return { levels: new Set(rules.map((r) => r.y1)), rules, seqY: letter.y };
    };

    // Two overlapping ranges need two levels; two separate ones share a single level.
    const over = bracketed([[5, 15], [10, 20]]);
    expect(over.rules.length).toBe(2);
    expect(over.levels.size).toBe(2);

    const apart = bracketed([[2, 5], [10, 14]]);
    expect(apart.rules.length).toBe(2);
    expect(apart.levels.size).toBe(1);

    // Stacking pushes the sequence further down, so the brackets never print over the ruler.
    expect(over.seqY).toBeGreaterThan(apart.seqY);
  });

  it('pushes the sequence row clear of the ruler as markings stack up', () => {
    const seqRowY = (regions: [number, number][]) => {
      const cfg = {
        ...defaultConfig(),
        intensityCols: ['t0'],
        highlightRegions: regions,
        highlightColors: regions.map(() => '#ff0000'),
      };
      const { figures } = buildLayout(seq, peptides, cfg, 30);
      const page = drawPage(figures[0], 0, seq, cfg);
      const letter = page.prims.find((p) => p.k === 'text' && p.text === seq[0]);
      if (letter?.k !== 'text') throw new Error('no sequence letter drawn');
      return letter.y;
    };

    const none = seqRowY([]);
    const one = seqRowY([[5, 8]]);
    // Three regions on the same stretch nest three frames, each staggered further out.
    const stacked = seqRowY([[5, 20], [8, 24], [12, 28]]);

    expect(one).toBeGreaterThan(none); // a marking buys clear air above the letters
    expect(stacked).toBeGreaterThan(one); // and more of it the deeper the stack
    // Non-overlapping regions need only one layer, so they cost no more than a single one.
    expect(seqRowY([[2, 4], [10, 12], [20, 22]])).toBe(one);
  });

  it('carries no edge where a region runs off the end of a row', () => {
    // 8-13 straddles the 10/11 wrap boundary: the first panel draws only its opening edge,
    // the second only its closing one. A line at the join would read as a boundary.
    const cfg = {
      ...defaultConfig(),
      intensityCols: ['t0'],
      highlightRegions: [[8, 13] as [number, number]],
      highlightColors: ['#ff0000'],
    };
    cfg.page.residuesPerRow = 10;
    const { figures } = buildLayout(seq, peptides, cfg, 10);
    const edgesOn = (pageIndex: number) =>
      drawPage(figures[0], pageIndex, seq, cfg).prims.filter(
        (p) => p.k === 'line' && p.stroke === '#ff0000',
      );
    const total = figures[0].pages.reduce((n, _, i) => n + edgesOn(i).length, 0);
    expect(total).toBe(2); // one opening edge, one closing edge, across the whole figure

    // A region wholly inside one row keeps both of its edges on that row.
    const inside = { ...cfg, highlightRegions: [[3, 7] as [number, number]] };
    const { figures: f2 } = buildLayout(seq, peptides, inside, 10);
    expect(
      drawPage(f2[0], 0, seq, inside).prims.filter((p) => p.k === 'line' && p.stroke === '#ff0000').length,
    ).toBe(2);
  });

  it('a highlight region label is drawn once per panel it is visible in', () => {
    const cfg = {
      ...defaultConfig(),
      intensityCols: ['t0'],
      highlightRegions: [[8, 13] as [number, number]],
      highlightColors: ['#0000ff'],
      highlightSpanAll: [true],
      highlightLabels: ['active site'],
    };
    cfg.page.residuesPerRow = 10;
    const { figures } = buildLayout(seq, peptides, cfg, 10);
    const prims = figures[0].pages.flatMap((_, i) => drawPage(figures[0], i, seq, cfg).prims);
    const labels = prims.filter((p) => p.k === 'text' && p.text === 'active site');
    // 8-13 straddles the 1-10 / 11-20 wrap boundary, so both panels carry the caption.
    expect(labels.length).toBe(2);
    expect(labels.every((p) => p.k === 'text' && p.fill === '#0000ff')).toBe(true);
    // A region with no label text draws nothing extra.
    const noLabel = { ...cfg, highlightLabels: [''] };
    const bare = figures[0].pages.flatMap((_, i) => drawPage(figures[0], i, seq, noLabel).prims);
    expect(bare.filter((p) => p.k === 'text' && p.text === 'active site').length).toBe(0);
  });

  it('a region caption never hides a residue number', () => {
    // A caption spanning the whole panel: previously every tick number under it was dropped.
    const cfg = {
      ...defaultConfig(),
      intensityCols: ['t0'],
      highlightRegions: [[1, 30] as [number, number]],
      highlightColors: ['#0000ff'],
      highlightSpanAll: [true],
      highlightLabels: ['a deliberately long caption'],
    };
    const withLabel = (labels: string[]) => {
      const c = { ...cfg, highlightLabels: labels };
      const { figures } = buildLayout(seq, peptides, c, 30);
      return drawPage(figures[0], 0, seq, c);
    };
    const ticks = (page: ReturnType<typeof drawPage>) =>
      page.prims.filter((p) => p.k === 'text' && /^\d+$/.test(p.text)).map((p) => (p.k === 'text' ? p.text : ''));

    // Every residue number drawn without a caption is still drawn with one.
    expect(ticks(withLabel(['a deliberately long caption']))).toEqual(ticks(withLabel([''])));

    // The caption sits above the ruler, not on it, and the panel is taller to make room.
    const labelled = withLabel(['a deliberately long caption']);
    const caption = labelled.prims.find((p) => p.k === 'text' && p.text === 'a deliberately long caption')!;
    const firstTick = labelled.prims.find((p) => p.k === 'text' && /^\d+$/.test(p.text))!;
    expect(caption.k === 'text' && firstTick.k === 'text' && caption.y < firstTick.y).toBe(true);
    expect(labelled.height).toBeGreaterThan(withLabel(['']).height);
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
