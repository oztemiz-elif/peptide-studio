// All visual + structural configuration: intensity, colors, notation, filters, fonts,
// highlights, modifications, splitting (both axes), page setup, and settings management.

import { useRef } from 'react';
import { saveAs } from 'file-saver';
import { Config, LegendBarLabels, LegendStyle, Notation, PeptideStyle, Transformation } from '../state/config';
import { exportConfigJson, importConfigJson, resetConfig, setConfig } from '../state/store';
import { autoResiduesPerRow, cellSize } from '../model/layout';
import { parseHighlightRegions, parseIndices } from '../model/regions';
import { Peptide, peptideId, peptideSequence } from '../model/peptides';

interface Props {
  config: Config;
  peptides: Peptide[];
  proteinSeq: string;
}

const rangesToText = (rs: [number, number][]) => rs.map((r) => `${r[0]}-${r[1]}`).join(', ');

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

  function addRegion() {
    setConfig({
      highlightRegions: [...config.highlightRegions, [1, 1]],
      highlightColors: [...(config.highlightColors ?? []), '#000000'],
    });
  }

  function removeRegion(i: number) {
    setConfig({
      highlightRegions: config.highlightRegions.filter((_, j) => j !== i),
      highlightColors: (config.highlightColors ?? []).filter((_, j) => j !== i),
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

  return (
    <section>
      <h2>Annotations</h2>
      <div className="field">
        <label>Highlight regions</label>
        {config.highlightRegions.length === 0 && (
          <span className="muted" style={{ fontSize: 11, marginTop: 2 }}>None added.</span>
        )}
        {config.highlightRegions.map((range, i) => (
          <div key={i} className="row" style={{ alignItems: 'center', marginTop: 5 }}>
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
              title="Outline color"
              onChange={(e) => updateColor(i, e.target.value)}
              style={{ width: 32, height: 28, padding: 1, flex: '0 0 auto', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}
            />
            <button
              title="Remove region"
              style={{ flex: '0 0 auto', padding: '3px 7px' }}
              onClick={() => removeRegion(i)}
            >
              ✕
            </button>
          </div>
        ))}
        <button style={{ marginTop: 7 }} onClick={addRegion}>+ Add region</button>
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
