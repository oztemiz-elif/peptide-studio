// File upload, sheet/column mapping, protein-sequence source, and UniProt search.
// Covers the data-input features from main.py's sidebar.

import { useState } from 'react';
import {
  Workbook,
  guessColumns,
  integerColumns,
  numericColumns,
  readWorkbook,
  sequenceFromColumn,
  textColumns,
} from '../io/parseExcel';
import { parseFasta } from '../io/parseFasta';
import { searchUniProt, UniProtHit } from '../io/uniprot';
import { validateSequence } from '../io/validateSequence';
import { Config, deriveTitleFromFilename } from '../state/config';
import { setConfig } from '../state/store';
import { SessionData, SeqSource } from './session';

interface Props {
  data: SessionData;
  setData: (updater: (d: SessionData) => SessionData) => void;
  config: Config;
}

export function DataInputs({ data, setData, config }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files) return;
    setError(null);
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.fasta') || lower.endsWith('.fa') || lower.endsWith('.fas')) {
          const seq = parseFasta(await file.text());
          setData((d) => ({ ...d, fastaSeq: seq, proteinSeq: seq, seqSource: 'fasta' }));
        } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.csv')) {
          const wb = await readWorkbook(file);
          loadSheet(wb, wb.sheetNames[0], file.name);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function loadSheet(wb: Workbook, sheetName: string, fileName?: string) {
    const { columns, rows } = wb.read(sheetName);
    const guess = guessColumns(columns, rows);
    setData((d) => ({
      ...d,
      workbook: wb,
      sheetNames: wb.sheetNames,
      sheetName,
      columns,
      rows,
      fileName: fileName ?? d.fileName,
    }));
    setConfig({
      startCol: guess.start ?? '',
      endCol: guess.end ?? '',
      intensityCols: guess.intensity,
      peptideSeqCol: guess.peptideSeq,
      timeLabels: Object.fromEntries(guess.intensity.map((c) => [c, c])),
      titleText: deriveTitleFromFilename(fileName ?? data.fileName, sheetName),
    });
  }

  const intCols = integerColumns(data.columns, data.rows);
  const numCols = numericColumns(data.columns, data.rows);
  const txtCols = textColumns(data.columns, data.rows);
  const validation = validateSequence(data.proteinSeq);

  function toggleIntensity(col: string) {
    const set = new Set(config.intensityCols);
    set.has(col) ? set.delete(col) : set.add(col);
    const cols = data.columns.filter((c) => set.has(c)); // keep file order
    const labels = { ...config.timeLabels };
    for (const c of cols) labels[c] ??= c;
    setConfig({ intensityCols: cols, timeLabels: labels });
  }

  return (
    <>
      <section>
        <h2>Data</h2>
        <div className="field">
          <label>Upload Excel / CSV / FASTA</label>
          <input
            type="file"
            multiple
            accept=".xlsx,.xls,.csv,.fasta,.fa,.fas"
            onChange={(e) => onFiles(e.target.files)}
          />
        </div>
        {busy && <p className="muted">Reading…</p>}
        {error && <p className="error">{error}</p>}
        {data.fileName && <p className="ok">Loaded: {data.fileName}</p>}

        {data.sheetNames.length > 1 && (
          <div className="field">
            <label>Sheet</label>
            <select
              value={data.sheetName}
              onChange={(e) => data.workbook && loadSheet(data.workbook, e.target.value)}
            >
              {data.sheetNames.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      <section>
        <h2>Protein sequence</h2>
        <div className="field">
          <label>Source</label>
          <select
            value={data.seqSource}
            onChange={(e) => onSeqSource(e.target.value as SeqSource)}
          >
            <option value="manual">Manual input</option>
            <option value="fasta" disabled={!data.fastaSeq}>
              From FASTA file
            </option>
            <option value="sheet" disabled={!data.columns.length}>
              From sheet column
            </option>
            <option value="search">UniProt search</option>
          </select>
        </div>

        {data.seqSource === 'sheet' && data.columns.length > 0 && (
          <div className="field">
            <label>Sequence column</label>
            <select
              onChange={(e) =>
                setData((d) => ({ ...d, proteinSeq: sequenceFromColumn(d.rows, e.target.value) }))
              }
              defaultValue=""
            >
              <option value="" disabled>
                Choose…
              </option>
              {[...txtCols, ...data.columns.filter((c) => !txtCols.includes(c))].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        )}

        {data.seqSource === 'search' && <UniProtSearch setData={setData} />}

        <div className="field">
          <label>Sequence ({data.proteinSeq.length} aa)</label>
          <textarea
            rows={4}
            value={data.proteinSeq}
            onChange={(e) => setData((d) => ({ ...d, proteinSeq: e.target.value }))}
          />
        </div>
        {data.proteinSeq &&
          (validation.isValid ? (
            <p className="ok">✓ Valid sequence</p>
          ) : (
            <p className="warn">
              ⚠ {validation.invalidPositions.length} invalid character(s).{' '}
              <button
                onClick={() => setData((d) => ({ ...d, proteinSeq: validation.cleaned }))}
              >
                Clean
              </button>
            </p>
          ))}
      </section>

      {data.columns.length > 0 && (
        <section>
          <h2>Column mapping</h2>
          <div className="row">
            <div className="field">
              <label>Start column</label>
              <select
                value={config.startCol}
                onChange={(e) => setConfig({ startCol: e.target.value })}
              >
                <option value="">—</option>
                {intCols.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>End column</label>
              <select value={config.endCol} onChange={(e) => setConfig({ endCol: e.target.value })}>
                <option value="">—</option>
                {intCols.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="field">
            <label>Peptide sequence column (optional)</label>
            <select
              value={config.peptideSeqCol ?? ''}
              onChange={(e) => setConfig({ peptideSeqCol: e.target.value || undefined })}
            >
              <option value="">(derive from sequence)</option>
              {txtCols.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Intensity columns</label>
            <div>
              {numCols.map((c) => (
                <label key={c} className="cb">
                  <input
                    type="checkbox"
                    checked={config.intensityCols.includes(c)}
                    onChange={() => toggleIntensity(c)}
                  />
                  {c}
                </label>
              ))}
            </div>
          </div>

          {config.intensityCols.length > 0 && (
            <div className="field">
              <label>Time-point labels</label>
              {config.intensityCols.map((c) => (
                <div className="row" key={c} style={{ alignItems: 'center', marginBottom: 3 }}>
                  <span className="muted" style={{ flex: '0 0 40%' }}>
                    {c}
                  </span>
                  <input
                    value={config.timeLabels[c] ?? c}
                    onChange={(e) =>
                      setConfig({ timeLabels: { ...config.timeLabels, [c]: e.target.value } })
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );

  function onSeqSource(src: SeqSource) {
    setData((d) => {
      let seq = d.proteinSeq;
      if (src === 'fasta') seq = d.fastaSeq ?? '';
      if (src === 'manual') seq = '';
      return { ...d, seqSource: src, proteinSeq: seq };
    });
  }
}

function UniProtSearch({ setData }: { setData: Props['setData'] }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<UniProtHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (!query.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      setHits(await searchUniProt(query.trim()));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <label>UniProt search</label>
      <div className="row">
        <input
          value={query}
          placeholder="name or accession (e.g. P02144)"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <button style={{ flex: '0 0 auto' }} onClick={run}>
          Search
        </button>
      </div>
      {busy && <p className="muted">Searching…</p>}
      {err && <p className="error">{err}</p>}
      {hits.length > 0 && (
        <select
          defaultValue=""
          onChange={(e) => {
            const hit = hits.find((h) => h.id === e.target.value);
            if (hit) setData((d) => ({ ...d, proteinSeq: hit.sequence }));
          }}
        >
          <option value="" disabled>
            {hits.length} result(s)…
          </option>
          {hits.map((h) => (
            <option key={h.accession} value={h.id}>
              {h.id} — {h.gene} — {h.organism} ({h.length} aa)
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
