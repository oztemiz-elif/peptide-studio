// All visual + structural configuration: intensity, colors, notation, filters, fonts,
// highlights, modifications, splitting (both axes), page setup, and settings management.

import { useRef, useState } from 'react';
import { saveAs } from 'file-saver';
import { Config, LegendBarLabels, LegendStyle, Notation, PeptideStyle, Transformation } from '../state/config';
import { exportConfigJson, importConfigJson, resetConfig, setConfig } from '../state/store';
import { autoResiduesPerRow, cellSize } from '../model/layout';
import { parseHighlightRegions, parseIndices } from '../model/regions';
import { detectClusters, SENSITIVITY, sensitivityLevel } from '../model/clusters';
import { computeIntensityScale } from '../model/filtering';
import { Peptide, peptideId, peptideSequence } from '../model/peptides';

interface Props {
  config: Config;
  peptides: Peptide[];
  proteinSeq: string;
}

const rangesToText = (rs: [number, number][]) => rs.map((r) => `${r[0]}-${r[1]}`).join(', ');

// Outline colours cycled through detected clusters. Deliberately blues/purples/teals — the
// intensity ramp runs yellow→orange→red, so a warm outline would read as data.
const CLUSTER_COLORS = ['#1f77b4', '#6a3d9a', '#0f766e', '#334155', '#c2185b'];

// Fill opacity for a new region, in percent. Visible as a tint without competing with the
// intensity colours underneath; raise it per region when a region needs to stand out.
const DEFAULT_OPACITY = 20;

export function ConfigPanel({ config, peptides, proteinSeq }: Props) {
  return (
    <>
      <IntensitySection config={config} />
      <ColorsSection config={config} />
      <FilterSection config={config} />
      <AnnotationSection config={config} peptides={peptides} proteinSeq={proteinSeq} />
      <PeptideStyleSection config={config} />
      <SplitSection config={config} />
      <PageSetupSection config={config} />
      <TypographySection config={config} />
      <SettingsSection />
    </>
  );
}

function IntensitySection({ config }: { config: Config }) {
  return (
    <section>
      <h2>Intensity</h2>
      <div className="field">
        <label>Transformation</label>
        <select
          value={config.transformation}
          onChange={(e) => {
            const transformation = e.target.value as Transformation;
            // Swap the "(Log2)"/"(Log10)" suffix on the legend title to match, as a
            // convenience default — the title remains plain, freely-editable text afterwards.
            const stripped = config.legendTitle.replace(/\s*\((Log2|Log10)\)\s*$/i, '');
            const suffix = transformation === 'log2' ? ' (Log2)' : transformation === 'log10' ? ' (Log10)' : '';
            setConfig({ transformation, legendTitle: `${stripped}${suffix}` });
          }}
        >
          <option value="none">None</option>
          <option value="log2">log2</option>
          <option value="log10">log10</option>
        </select>
      </div>
      <div className="row">
        <NumField
          label="Min intensity"
          value={config.minIntensity}
          placeholder="auto"
          onChange={(v) => setConfig({ minIntensity: v })}
        />
        <NumField
          label="Max intensity"
          value={config.maxIntensity}
          placeholder="auto"
          onChange={(v) => setConfig({ maxIntensity: v })}
        />
      </div>
      <div className="field">
        <label>Notation</label>
        <select
          value={config.notation}
          onChange={(e) => setConfig({ notation: e.target.value as Notation })}
        >
          <option value="superscript">Superscript (1.25 × 10¹⁵)</option>
          <option value="exponential">Exponential (1.25E15)</option>
          <option value="integer">Integer</option>
          <option value="float">Float (2 dp)</option>
        </select>
      </div>
      <div className="field">
        <label>Legend title</label>
        <input
          value={config.legendTitle}
          onChange={(e) => setConfig({ legendTitle: e.target.value })}
        />
      </div>
      <div className="field">
        <label>Legend style</label>
        <select
          value={config.legendStyle}
          onChange={(e) => setConfig({ legendStyle: e.target.value as LegendStyle })}
        >
          <option value="bar">Gradient bar (High / Low)</option>
          <option value="list">Line-by-line list (with ranges)</option>
        </select>
      </div>
      {config.legendStyle === 'bar' && (
        <div className="field">
          <label>Bar labels</label>
          <select
            value={config.legendBarLabels}
            onChange={(e) => setConfig({ legendBarLabels: e.target.value as LegendBarLabels })}
          >
            <option value="highlow">High / Low</option>
            <option value="numbers">Min / Max values</option>
          </select>
        </div>
      )}
      <label className="cb" style={{ marginTop: 4 }}>
        <input
          type="checkbox"
          checked={config.legendOnEveryPage}
          onChange={(e) => setConfig({ legendOnEveryPage: e.target.checked })}
        />
        Show legend on every page
      </label>
      <div className="field">
        <label>Legend position &amp; size</label>
        <p className="hint" style={{ margin: '0 0 4px' }}>
          Drag a legend box on the chart to reposition it, or drag the blue handle at its
          top-left corner to resize it. Double-click a legend to reset its position and size.
          Each split page/figure has its own legend; use Print preview (above the chart) to
          arrange them exactly as they'll print.
        </p>
      </div>
      {(Object.keys(config.legendOffsets).length > 0 || Object.keys(config.legendScales).length > 0) && (
        <button type="button" onClick={() => setConfig({ legendOffsets: {}, legendScales: {} })}>
          Reset all legend positions &amp; sizes
        </button>
      )}
    </section>
  );
}

function ColorsSection({ config }: { config: Config }) {
  function setColor(i: number, val: string) {
    const colors = [...config.colors];
    colors[i] = val;
    setConfig({ colors });
  }
  return (
    <section>
      <h2>Colors ({config.colors.length} bins, low → high)</h2>
      <div className="colors">
        {config.colors.map((c, i) => (
          <input key={i} type="color" value={c} onChange={(e) => setColor(i, e.target.value)} />
        ))}
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <button
          onClick={() => setConfig({ colors: [...config.colors, '#444444'] })}
          disabled={config.colors.length >= 12}
        >
          + Add bin
        </button>
        <button
          onClick={() => setConfig({ colors: config.colors.slice(0, -1) })}
          disabled={config.colors.length <= 2}
        >
          − Remove bin
        </button>
      </div>
    </section>
  );
}

function FilterSection({ config }: { config: Config }) {
  return (
    <section>
      <h2>Peptide filters</h2>
      <div className="row">
        <NumField
          label="Min length"
          value={config.minPeptideLength}
          onChange={(v) => setConfig({ minPeptideLength: v ?? 1 })}
        />
        <NumField
          label="Max length"
          value={config.maxPeptideLength}
          placeholder="none"
          onChange={(v) => setConfig({ maxPeptideLength: v })}
        />
      </div>
    </section>
  );
}

function AnnotationSection({
  config,
  peptides,
  proteinSeq,
}: {
  config: Config;
  peptides: Peptide[];
  proteinSeq: string;
}) {
  // Two distinct peptide rows can share the same start-end (e.g. the same sequence
  // identified across replicates/charge states) and therefore the same peptideId — the
  // rendering pipeline already treats them as one entity (layout.ts keys row-assignment
  // and modifications by this id too), so de-duplicate here as well. Otherwise the
  // dropdown below would render two <option> elements with the same key, which is an
  // invalid duplicate React key and can corrupt the DOM on reconciliation.
  const ids = Array.from(new Set(peptides.map(peptideId)));
  const [clusterStatus, setClusterStatus] = useState('');
  const sensLevel = sensitivityLevel(config.clusterMinSharedPeptides, config.clusterEnrichmentFactor);

  function addRegion() {
    setConfig({
      highlightRegions: [...config.highlightRegions, [1, 1]],
      highlightColors: [...(config.highlightColors ?? []), '#000000'],
      highlightSpanAll: [...(config.highlightSpanAll ?? []), false],
      highlightBracket: [...(config.highlightBracket ?? []), false],
      highlightLabels: [...(config.highlightLabels ?? []), ''],
      highlightOpacity: [...(config.highlightOpacity ?? []), DEFAULT_OPACITY],
    });
  }

  function removeRegion(i: number) {
    setConfig({
      highlightRegions: config.highlightRegions.filter((_, j) => j !== i),
      highlightColors: (config.highlightColors ?? []).filter((_, j) => j !== i),
      highlightSpanAll: (config.highlightSpanAll ?? []).filter((_, j) => j !== i),
      highlightBracket: (config.highlightBracket ?? []).filter((_, j) => j !== i),
      highlightLabels: (config.highlightLabels ?? []).filter((_, j) => j !== i),
      highlightOpacity: (config.highlightOpacity ?? []).filter((_, j) => j !== i),
    });
  }

  function updateStart(i: number, val: number) {
    const regions = config.highlightRegions.map((r, j) =>
      j === i ? ([val, r[1]] as [number, number]) : r,
    );
    setConfig({ highlightRegions: regions });
  }

  function updateEnd(i: number, val: number) {
    const regions = config.highlightRegions.map((r, j) =>
      j === i ? ([r[0], val] as [number, number]) : r,
    );
    setConfig({ highlightRegions: regions });
  }

  function updateColor(i: number, color: string) {
    const colors = [...(config.highlightColors ?? [])];
    while (colors.length <= i) colors.push('#000000');
    colors[i] = color;
    setConfig({ highlightColors: colors });
  }

  function updateOpacity(i: number, pct: number) {
    const opacity = [...(config.highlightOpacity ?? [])];
    while (opacity.length <= i) opacity.push(DEFAULT_OPACITY);
    opacity[i] = Math.min(100, Math.max(0, pct));
    setConfig({ highlightOpacity: opacity });
  }

  // Configs saved before these fields existed have shorter (or empty) parallel arrays, so
  // every setter pads up to `i` with the default before writing.
  //
  // The three marking styles are exclusive, and the two flags behind them are not — so they
  // are written as a pair here rather than left to the renderer's precedence rule. A figure
  // saved before brackets existed has no flag at all and reads as its old style.
  function updateStyle(i: number, style: 'row' | 'span' | 'bracket') {
    const spans = [...(config.highlightSpanAll ?? [])];
    const brackets = [...(config.highlightBracket ?? [])];
    while (spans.length <= i) spans.push(false);
    while (brackets.length <= i) brackets.push(false);
    spans[i] = style === 'span';
    brackets[i] = style === 'bracket';
    setConfig({ highlightSpanAll: spans, highlightBracket: brackets });
  }

  const styleOf = (i: number): 'row' | 'span' | 'bracket' =>
    (config.highlightBracket ?? [])[i] ? 'bracket' : (config.highlightSpanAll ?? [])[i] ? 'span' : 'row';

  function updateLabel(i: number, text: string) {
    const labels = [...(config.highlightLabels ?? [])];
    while (labels.length <= i) labels.push('');
    labels[i] = text;
    setConfig({ highlightLabels: labels });
  }

  function identifyClusters() {
    if (!proteinSeq) return setClusterStatus('Load a protein sequence first.');
    if (!peptides.length) return setClusterStatus('Load a peptide table first.');
    if (!config.intensityCols.length) return setClusterStatus('Select at least one intensity column first.');

    const scale = computeIntensityScale(peptides, config.intensityCols, config);
    const { clusters, sharedStarts, sharedEnds } = detectClusters(
      peptides,
      proteinSeq.length,
      config.intensityCols,
      config,
      scale,
      {
        minLength: config.clusterMinLength,
        maxLength: config.clusterMaxLength,
        minSharedPeptides: config.clusterMinSharedPeptides,
        enrichmentFactor: config.clusterEnrichmentFactor,
        concentrationPercent: config.clusterConcentrationPercent,
        mergeOverlapPercent: config.clusterMergeOverlapPercent,
        hierarchical: config.clusterHierarchical,
        membershipPercent: config.clusterMembershipPercent,
      },
    );

    // Drop the previous detection run, keep everything added by hand, then append the new
    // clusters. Re-running is therefore idempotent instead of piling up duplicates.
    const keep = config.highlightRegions
      .map((_, i) => i)
      .filter((i) => !((config.highlightAuto ?? [])[i] ?? false));
    const regions = keep.map((i) => config.highlightRegions[i]);
    const colors = keep.map((i) => (config.highlightColors ?? [])[i] ?? '#000000');
    const spans = keep.map((i) => (config.highlightSpanAll ?? [])[i] ?? false);
    const brackets = keep.map((i) => (config.highlightBracket ?? [])[i] ?? false);
    const labels = keep.map((i) => (config.highlightLabels ?? [])[i] ?? '');
    const opacity = keep.map((i) => (config.highlightOpacity ?? [])[i] ?? DEFAULT_OPACITY);
    const autos = keep.map(() => false);

    // In hierarchical mode a derived sub-cluster is labelled against its parent ("2.1"), so
    // the figure shows which boxes are the same species trimmed further.
    const childIndex = new Map<number, number>();
    clusters.forEach((c, i) => {
      regions.push([c.start, c.end]);
      colors.push(CLUSTER_COLORS[i % CLUSTER_COLORS.length]);
      spans.push(true);
      brackets.push(false); // a detected cluster is a span-all box, as before
      if (c.parent == null) {
        labels.push(`Cluster ${i + 1}`);
      } else {
        const n = (childIndex.get(c.parent) ?? 0) + 1;
        childIndex.set(c.parent, n);
        labels.push(`Cluster ${c.parent + 1}.${n}`);
      }
      opacity.push(DEFAULT_OPACITY);
      autos.push(true);
    });

    setConfig({
      highlightRegions: regions,
      highlightColors: colors,
      highlightSpanAll: spans,
      highlightBracket: brackets,
      highlightLabels: labels,
      highlightOpacity: opacity,
      highlightAuto: autos,
    });

    // Report how each far edge was decided, since that is how much you can trust it: an edge
    // several peptides agreed on is reportable, one taken from the longest member is not.
    const basis = `${sharedStarts} N-terminal and ${sharedEnds} C-terminal position${sharedEnds === 1 ? '' : 's'} stood out enough to anchor a cluster.`;
    if (!clusters.length) {
      setClusterStatus(`${basis} None survived — try moving Sensitivity toward "more, weaker", or a shorter minimum length.`);
    } else {
      const both = clusters.filter((c) => c.farEdge === 'shared').length;
      const capped = clusters.filter((c) => c.farEdge === 'capped').length;
      // Only the shared-terminus count is worth surfacing here: it says how many clusters have
      // two edges you could quote. How the remainder were closed is explained in the manual
      // rather than restated on every run.
      const parts = [`${both} closed on a shared terminus`];
      if (capped) parts.push(`${capped} cut short by max length`);
      setClusterStatus(
        `${basis} ${clusters.length} cluster${clusters.length === 1 ? '' : 's'} — ` +
          parts.join(', ') +
          ': ' +
          clusters.map((c) => `${c.start}–${c.end}`).join(', '),
      );
    }
  }

  return (
    <section>
      <h2>Annotations</h2>
      <div className="field">
        <label>Highlight regions</label>
        {config.highlightRegions.length === 0 && (
          <span className="muted" style={{ fontSize: 11, marginTop: 2 }}>None added.</span>
        )}
        {config.highlightRegions.map((range, i) => (
          <div key={i} style={{ marginTop: 7 }}>
            <div className="row" style={{ alignItems: 'center' }}>
              <input
                type="number"
                min={1}
                value={range[0]}
                title="Start residue"
                style={{ minWidth: 0 }}
                onChange={(e) => updateStart(i, parseInt(e.target.value, 10) || 1)}
              />
              <span style={{ flex: '0 0 auto', color: '#9ca3af', fontWeight: 600 }}>–</span>
              <input
                type="number"
                min={1}
                value={range[1]}
                title="End residue"
                style={{ minWidth: 0 }}
                onChange={(e) => updateEnd(i, parseInt(e.target.value, 10) || 1)}
              />
              <input
                type="color"
                value={(config.highlightColors ?? [])[i] ?? '#000000'}
                title="Region colour — outline and fill"
                onChange={(e) => updateColor(i, e.target.value)}
                style={{ width: 32, height: 28, padding: 1, flex: '0 0 auto', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}
              />
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                value={(config.highlightOpacity ?? [])[i] ?? DEFAULT_OPACITY}
                title="Fill opacity, %. The sequence always stays on top of the fill; where the fill is dark the letters turn white by themselves."
                style={{ width: 54, minWidth: 0, flex: '0 0 auto' }}
                onChange={(e) => updateOpacity(i, parseInt(e.target.value, 10) || 0)}
              />
              <button
                title="Remove region"
                style={{ flex: '0 0 auto', padding: '3px 7px' }}
                onClick={() => removeRegion(i)}
              >
                ✕
              </button>
            </div>
            <input
              type="text"
              value={(config.highlightLabels ?? [])[i] ?? ''}
              placeholder="Label (optional, e.g. active site)"
              title="Caption drawn above the box, in the region's colour"
              style={{ marginTop: 4, width: '100%' }}
              onChange={(e) => updateLabel(i, e.target.value)}
            />
            <select
              value={styleOf(i)}
              onChange={(e) => updateStyle(i, e.target.value as 'row' | 'span' | 'bracket')}
              style={{ marginTop: 3, width: '100%' }}
              title="How this region is marked on the figure"
            >
              <option value="row">Edges on the sequence row</option>
              <option value="span">Edges spanning all time points</option>
              <option value="bracket">Bracket above the sequence</option>
            </select>
          </div>
        ))}
        <button style={{ marginTop: 7 }} onClick={addRegion}>+ Add region</button>
      </div>

      <div className="field">
        <label>Detect clusters</label>
        <span className="muted" style={{ fontSize: 11, marginTop: 2 }}>
          Finds groups of peptides sharing an N-terminus — or a C-terminus — at the same
          residue. Open the <b>Coverage &amp; termini profile</b> above the figure to watch the
          threshold move as you change the dial, and drag a cluster's edge there to correct it
          by hand.
        </span>

        <div className="row" style={{ marginTop: 8, alignItems: 'flex-end' }}>
          <NumField
            label="Shortest cluster (aa)"
            value={config.clusterMinLength}
            onChange={(v) => setConfig({ clusterMinLength: Math.max(1, v ?? 1) })}
          />
          <NumField
            label="Longest cluster (aa)"
            value={config.clusterMaxLength}
            onChange={(v) => setConfig({ clusterMaxLength: Math.max(1, v ?? 1) })}
          />
        </div>

        <div className="field" style={{ marginTop: 8, marginBottom: 0 }}>
          <label>Sensitivity — {sensLevel >= 0 ? SENSITIVITY[sensLevel].label : 'Custom'}</label>
          <input
            type="range"
            min={0}
            max={SENSITIVITY.length - 1}
            step={1}
            value={sensLevel >= 0 ? sensLevel : 2}
            onChange={(e) => {
              const s = SENSITIVITY[parseInt(e.target.value, 10)];
              setConfig({
                clusterMinSharedPeptides: s.minSharedPeptides,
                clusterEnrichmentFactor: s.enrichmentFactor,
              });
            }}
          />
          <div className="row" style={{ justifyContent: 'space-between', fontSize: 10, color: '#9ca3af' }}>
            <span>fewer, surer</span>
            <span>more, weaker</span>
          </div>
          <span className="muted" style={{ fontSize: 11 }}>
            A residue starts a cluster when at least <b>{config.clusterMinSharedPeptides}</b> peptides
            share it as their N-terminus (or C-terminus), and that is at least{' '}
            <b>{config.clusterEnrichmentFactor}×</b> as many as a typical residue nearby.
          </span>
        </div>

        <button style={{ marginTop: 9 }} onClick={identifyClusters}>Identify clusters</button>
        {clusterStatus && (
          <span className="muted" style={{ fontSize: 11, marginTop: 4 }}>{clusterStatus}</span>
        )}
        <span className="muted" style={{ fontSize: 11, marginTop: 2 }}>
          Re-running replaces the clusters found last time; anything you added or dragged is kept.
        </span>

        <details style={{ marginTop: 9 }}>
          <summary style={{ fontSize: 12 }}>Fine tuning</summary>
          <div style={{ marginTop: 7 }}>
            <div className="row">
              <NumField
                label="Min termini at a position"
                value={config.clusterMinSharedPeptides}
                onChange={(v) => setConfig({ clusterMinSharedPeptides: Math.max(1, v ?? 1) })}
              />
              <NumField
                label="Times a typical nearby residue (×)"
                value={config.clusterEnrichmentFactor}
                onChange={(v) => setConfig({ clusterEnrichmentFactor: Math.max(0, v ?? 0) })}
              />
            </div>
            <span className="muted" style={{ fontSize: 11 }}>
              The two the dial sets. Editing them directly shows the dial as “Custom”. The second
              compares a residue with the ones around it, so the same value means the same thing
              in a busy protein and a sparse one.
            </span>

            <NumField
              label="Shared terminus needed to close a cluster (%)"
              value={config.clusterConcentrationPercent}
              onChange={(v) => setConfig({ clusterConcentrationPercent: Math.min(100, Math.max(1, v ?? 40)) })}
            />
            <span className="muted" style={{ fontSize: 11 }}>
              A cluster is anchored where a group shares one terminus. It closes at a residue
              where at least this share of them share the <i>other</i> terminus. Below it there
              is no agreed second edge, so the cluster stops where the group thins out. Works
              the same whichever terminus the group happens to share.
            </span>

            <NumField
              label="Peptide counts as part of a cluster at (%)"
              value={config.clusterMembershipPercent}
              onChange={(v) => setConfig({ clusterMembershipPercent: Math.min(100, Math.max(1, v ?? 50)) })}
            />
            <span className="muted" style={{ fontSize: 11 }}>
              A peptide counts when it shares at least this much of the cluster <i>or</i> this
              much of itself with it — so a short peptide sitting inside counts, a long one
              spanning the whole cluster counts, and one merely clipping an edge does not. Sets
              the peptide count and the intensity figures in the table, and the count clusters
              are ranked by.
            </span>

            <NumField
              label="Merge clusters overlapping by more than (%)"
              value={config.clusterMergeOverlapPercent}
              onChange={(v) => setConfig({ clusterMergeOverlapPercent: Math.min(100, Math.max(1, v ?? 80)) })}
            />
            <span className="muted" style={{ fontSize: 11 }}>
              Only for clusters of similar length side by side. One sitting wholly inside another
              is always merged, whatever this says.
            </span>

            <label className="cb" style={{ marginTop: 6 }}>
              <input
                type="checkbox"
                checked={config.clusterHierarchical}
                onChange={(e) => setConfig({ clusterHierarchical: e.target.checked })}
              />
              Keep sub-clusters separately (2.1, 2.2…) instead of merging into the parent
            </label>
          </div>
        </details>
      </div>

      <div className="field">
        <label>Modifications (per peptide, positions within peptide)</label>
        <select
          defaultValue=""
          onChange={(e) => {
            const id = e.target.value;
            if (id && !(id in config.modifications)) {
              setConfig({ modifications: { ...config.modifications, [id]: [] } });
            }
          }}
        >
          <option value="">Add peptide…</option>
          {ids.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        {Object.entries(config.modifications).map(([id, positions]) => {
          const [s, e] = id.split('-').map(Number);
          const seq = proteinSeq ? peptideSequence(proteinSeq, s, e) : '';
          return (
            <div key={id} style={{ marginTop: 6 }}>
              <div className="row" style={{ alignItems: 'center' }}>
                <span className="tag">{id}</span>
                <input
                  style={{ flex: 1 }}
                  defaultValue={positions.map((p) => p + 1).join(',')}
                  placeholder="1,3,5-7"
                  onBlur={(ev) => {
                    const zeroBased = parseIndices(ev.target.value).map((p) => p - 1);
                    setConfig({ modifications: { ...config.modifications, [id]: zeroBased } });
                  }}
                />
                <button
                  style={{ flex: '0 0 auto' }}
                  onClick={() => {
                    const m = { ...config.modifications };
                    delete m[id];
                    setConfig({ modifications: m });
                  }}
                >
                  ✕
                </button>
              </div>
              {seq && <div className="muted">{seq}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const LINE_THICKNESS_OPTIONS: [number, string][] = [
  [1, 'Thin'],
  [2, 'Medium'],
  [3.5, 'Bold'],
  [5, 'Extra bold'],
];

function PeptideStyleSection({ config }: { config: Config }) {
  return (
    <section>
      <h2>Peptide visualization</h2>
      <div className="field">
        <label>Style</label>
        <select
          value={config.peptideStyle}
          onChange={(e) => setConfig({ peptideStyle: e.target.value as PeptideStyle })}
        >
          <option value="box">Boxes (letters — original look)</option>
          <option value="line">Lines (compact — fits more overlapping peptides)</option>
        </select>
      </div>

      {config.peptideStyle === 'line' && (
        <div className="field">
          <label>Line boldness</label>
          <select
            value={config.lineThickness}
            onChange={(e) => setConfig({ lineThickness: Number(e.target.value) })}
          >
            {LINE_THICKNESS_OPTIONS.map(([pt, name]) => (
              <option key={pt} value={pt}>
                {name} ({pt}pt)
              </option>
            ))}
          </select>
        </div>
      )}

      <label className="cb">
        <input
          type="checkbox"
          checked={config.showResidueGridlines}
          onChange={(e) => setConfig({ showResidueGridlines: e.target.checked })}
        />
        Thin dashed guide lines between residues (trace where a peptide line starts/ends)
      </label>
    </section>
  );
}

function SplitSection({ config }: { config: Config }) {
  const numFigures = Math.max(1, config.timeGroups.length || 1);

  function setNumFigures(n: number) {
    const groups: string[][] = [];
    const cols = config.intensityCols;
    if (n <= 1) {
      setConfig({ timeGroups: [] });
      return;
    }
    // distribute columns sequentially across figures (mirrors the original default)
    const per = Math.ceil(cols.length / n);
    for (let i = 0; i < n; i++) groups.push(cols.slice(i * per, (i + 1) * per));
    setConfig({ timeGroups: groups });
  }

  function toggleCol(fig: number, col: string) {
    const groups = config.timeGroups.map((g) => [...g]);
    const set = new Set(groups[fig]);
    set.has(col) ? set.delete(col) : set.add(col);
    groups[fig] = config.intensityCols.filter((c) => set.has(c));
    setConfig({ timeGroups: groups });
  }

  return (
    <section>
      <h2>Splitting</h2>

      <div className="field">
        <label>Vertical split — sequence ranges (e.g. 1-150, 151-300)</label>
        <input
          defaultValue={rangesToText(config.sequenceSplits)}
          placeholder="blank = whole sequence"
          onBlur={(e) => setConfig({ sequenceSplits: parseHighlightRegions(e.target.value) })}
        />
      </div>

      <div className="field">
        <label>Horizontal split — number of figures (by time points)</label>
        <input
          type="number"
          min={1}
          max={20}
          value={numFigures}
          onChange={(e) => setNumFigures(parseInt(e.target.value, 10) || 1)}
        />
      </div>

      {numFigures > 1 && (
        <div className="field">
          <label className="cb">
            <input
              type="checkbox"
              checked={config.appendFigureNumbers}
              onChange={(e) => setConfig({ appendFigureNumbers: e.target.checked })}
            />
            Append "— Figure N" to title
          </label>
        </div>
      )}

      {numFigures > 1 &&
        config.timeGroups.map((group, fi) => (
          <div className="field" key={fi}>
            <label>Figure {fi + 1} columns</label>
            <div>
              {config.intensityCols.map((c) => (
                <label key={c} className="cb">
                  <input
                    type="checkbox"
                    checked={group.includes(c)}
                    onChange={() => toggleCol(fi, c)}
                  />
                  {config.timeLabels[c] ?? c}
                </label>
              ))}
            </div>
          </div>
        ))}
    </section>
  );
}

function PageSetupSection({ config }: { config: Config }) {
  const p = config.page;
  const set = (patch: Partial<Config['page']>) => setConfig({ page: { ...p, ...patch } });
  return (
    <section>
      <h2>Page setup (print / "punto")</h2>
      <div className="row">
        <div className="field">
          <label>Page size</label>
          <select value={p.size} onChange={(e) => set({ size: e.target.value as typeof p.size })}>
            <option value="A4">A4</option>
            <option value="Letter">Letter</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div className="field">
          <label>Orientation</label>
          <select
            value={p.orientation}
            onChange={(e) => set({ orientation: e.target.value as typeof p.orientation })}
          >
            <option value="landscape">Landscape</option>
            <option value="portrait">Portrait</option>
          </select>
        </div>
      </div>

      {p.size === 'custom' && (
        <div className="row">
          <NumField label="Width (mm)" value={p.customWidthMm} onChange={(v) => set({ customWidthMm: v ?? 297 })} />
          <NumField label="Height (mm)" value={p.customHeightMm} onChange={(v) => set({ customHeightMm: v ?? 210 })} />
        </div>
      )}

      <label className="cb" style={{ marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={config.autoFitWidth}
          onChange={(e) => setConfig({ autoFitWidth: e.target.checked })}
        />
        Auto-fit sequence per row to screen width (on-screen view only)
      </label>

      <label className="cb" style={{ marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={p.autoSizeToPage}
          onChange={(e) => set({ autoSizeToPage: e.target.checked })}
        />
        Auto-size to page: fill each printed/exported page at the chosen font size, with no rescaling
      </label>

      {p.autoSizeToPage ? (
        <p className="muted" style={{ marginTop: -4, marginBottom: 10, fontSize: 12 }}>
          Sequence/row and rows/page below are computed from the page size, orientation and
          margins so the configured font sizes print 1:1 — adjust those instead to change the fit.
          {' '}≈ <strong>{autoResiduesPerRow(config)}</strong> residues/row at this size.
        </p>
      ) : null}

      <label className="cb" style={{ marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={config.packNarrowSegments}
          onChange={(e) => setConfig({ packNarrowSegments: e.target.checked })}
        />
        Pack narrow segments into side-by-side columns
      </label>
      <p className="muted" style={{ marginTop: -4, marginBottom: 10, fontSize: 12 }}>
        A short leftover segment (e.g. the end of a long sequence) whose time-point bands would
        otherwise run tall down many half-empty pages is laid out in newspaper columns that fill
        the page width — each column repeating the residue ruler. Only applies where 2+ columns fit.
      </p>

      <div className="row">
        <NumField
          label="Sequence / row"
          value={p.autoSizeToPage ? autoResiduesPerRow(config) : p.residuesPerRow}
          disabled={p.autoSizeToPage}
          onChange={(v) => set({ residuesPerRow: v ?? 60 })}
        />
        <div className="field">
          <label>Rows / page</label>
          <input
            value={p.autoSizeToPage || p.rowsPerPage === 'auto' ? '' : p.rowsPerPage}
            placeholder={p.autoSizeToPage ? 'auto (fills page)' : 'auto'}
            disabled={p.autoSizeToPage}
            onChange={(e) =>
              set({ rowsPerPage: e.target.value === '' ? 'auto' : parseInt(e.target.value, 10) || 'auto' })
            }
          />
        </div>
      </div>

      <div className="field">
        <label>Manual page breaks (residue positions, e.g. 121, 241)</label>
        <input
          defaultValue={p.manualBreaks.join(', ')}
          placeholder="none"
          onBlur={(e) =>
            set({
              manualBreaks: parseIndices(e.target.value),
            })
          }
        />
      </div>
      <NumField label="Margins (mm)" value={p.margins} onChange={(v) => set({ margins: v ?? 10 })} />
    </section>
  );
}

function TypographySection({ config }: { config: Config }) {
  const fs = config.fontSizes;
  const setFs = (patch: Partial<Config['fontSizes']>) =>
    setConfig({ fontSizes: { ...fs, ...patch } });
  return (
    <section>
      <h2>Typography</h2>
      <div className="field">
        <label>Title</label>
        <input value={config.titleText} onChange={(e) => setConfig({ titleText: e.target.value })} />
      </div>
      <div className="field">
        <label>Font family</label>
        <input
          value={config.fontFamily}
          onChange={(e) => setConfig({ fontFamily: e.target.value })}
        />
      </div>
      <div className="row">
        <NumField label="Title size" value={fs.title} onChange={(v) => setFs({ title: v ?? 24 })} />
        <NumField label="Sequence size" value={fs.residue} onChange={(v) => setFs({ residue: v ?? 10 })} />
      </div>
      <div className="field">
        <label>
          Letter packing — squares {config.cellScale.toFixed(2)}× font (≈ {cellSize(config)}pt)
        </label>
        <input
          type="range"
          min={0.8}
          max={1.6}
          step={0.05}
          value={config.cellScale}
          onChange={(e) => setConfig({ cellScale: parseFloat(e.target.value) })}
        />
        <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
          Lower = tighter squares with less gap between letters, fitting more residues per row
          and more data per page. Letters stay legible down to ~0.85.
        </p>
      </div>
      <div className="row">
        <NumField label="Tick size" value={fs.tick} onChange={(v) => setFs({ tick: v ?? 12 })} />
        <NumField label="Label size" value={fs.timeLabel} onChange={(v) => setFs({ timeLabel: v ?? 12 })} />
      </div>
      <div className="row">
        <NumField label="Legend title" value={fs.legendTitle} onChange={(v) => setFs({ legendTitle: v ?? 18 })} />
        <NumField label="Legend label" value={fs.legendLabel} onChange={(v) => setFs({ legendLabel: v ?? 16 })} />
      </div>
    </section>
  );
}

function SettingsSection() {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <section>
      <h2>Settings</h2>
      <div className="row">
        <button onClick={() => saveAs(new Blob([exportConfigJson()], { type: 'application/json' }), 'settings.json')}>
          Export
        </button>
        <button onClick={() => fileRef.current?.click()}>Import</button>
        <button onClick={() => resetConfig()}>Reset</button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) importConfigJson(await f.text());
          e.target.value = '';
        }}
      />
      <p className="muted">Settings auto-save to your browser.</p>
    </section>
  );
}

function NumField({
  label,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  value: number | undefined;
  placeholder?: string;
  disabled?: boolean;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type="number"
        value={value ?? ''}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    </div>
  );
}
