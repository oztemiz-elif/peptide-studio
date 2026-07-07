import { useEffect, useMemo, useState } from 'react';
import { setConfig, useConfig } from '../state/store';
import { datetimeSuffix, sanitizeFilename } from '../state/config';
import { buildPeptides } from '../io/parseExcel';
import {
  computeIntensityScale,
  displayedPeptideIds,
  identifyRemovedPeptides,
} from '../model/filtering';
import { autoResiduesPerRow, cellSize, leftLabelWidth, PT_PER_MM } from '../model/layout';
import { Figures } from '../render/Figures';
import { exportAll } from '../export/toZip';
import { DataInputs } from './DataInputs';
import { ConfigPanel } from './ConfigPanel';
import { RemovedPeptides } from './RemovedPeptides';
import { useContainerWidth } from './useContainerWidth';
import { emptySession, SessionData } from './session';
import logoLight from '../../assets/PeptideStudio_logo_light.svg';

function pageDimsMm(config: ReturnType<typeof useConfig>): [number, number] {
  const sizes: Record<string, [number, number]> = { A4: [210, 297], Letter: [215.9, 279.4] };
  let [w, h] =
    config.page.size === 'custom'
      ? [config.page.customWidthMm, config.page.customHeightMm]
      : sizes[config.page.size];
  if (config.page.orientation === 'landscape' && w < h) [w, h] = [h, w];
  if (config.page.orientation === 'portrait' && w > h) [w, h] = [h, w];
  return [w, h];
}

export function App() {
  const config = useConfig();
  const [data, setDataState] = useState<SessionData>(emptySession);
  // A pending output action forces the fixed (paginated) layout before printing/exporting,
  // so the output uses config.page.residuesPerRow and the configured font sizes 1:1.
  const [outputAction, setOutputAction] = useState<null | 'print' | 'png' | 'jpeg' | 'svg' | 'eps'>(null);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [mainRef, mainWidth] = useContainerWidth<HTMLDivElement>();

  const setData = (updater: (d: SessionData) => SessionData) => setDataState(updater);

  const peptides = useMemo(
    () =>
      config.startCol && config.endCol && config.intensityCols.length
        ? buildPeptides(data.rows, config.startCol, config.endCol, config.intensityCols, config.peptideSeqCol)
        : [],
    [data.rows, config.startCol, config.endCol, config.intensityCols, config.peptideSeqCol],
  );

  // The SVG coordinate unit is 1 point (1/72"). Convert screen px (96 dpi) to points.
  const PX_TO_PT = 72 / 96;

  // Responsive residues-per-row from the available width — purely an on-screen viewing
  // convenience; print/export sizing below is governed independently by autoSizeToPage.
  const responsiveRpr = useMemo(() => {
    const cell = cellSize(config);
    const fit = Math.floor((mainWidth * PX_TO_PT - leftLabelWidth(config)) / cell);
    return Math.max(10, fit);
  }, [mainWidth, config]);

  // For print/export, when autoSizeToPage is on, fit residues-per-row to the printable
  // page width at the configured font size so the page fills edge-to-edge at 1:1 (no
  // browser rescaling). Page height is handled by computePageStarts inside buildLayout.
  const pageFitRpr = useMemo(() => autoResiduesPerRow(config), [config]);

  // Print preview mirrors the same fixed pagination used for an actual print/export, so
  // page breaks and per-page legend positions can be previewed and arranged ahead of time.
  const useFixedLayout = !!outputAction || config.printPreview;
  const residuesPerRow = useFixedLayout
    ? config.page.autoSizeToPage
      ? pageFitRpr
      : config.page.residuesPerRow
    : config.autoFitWidth
    ? responsiveRpr
    : config.page.residuesPerRow;

  // Report data (across all selected intensity columns).
  const report = useMemo(() => {
    if (!peptides.length || !config.intensityCols.length) return null;
    const scale = computeIntensityScale(peptides, config.intensityCols, config);
    const removed = identifyRemovedPeptides(peptides, data.proteinSeq, config.intensityCols, config, scale);
    const displayed = displayedPeptideIds(peptides, config.intensityCols, config, scale).size;
    return { scale, removed, displayed, total: peptides.length };
  }, [peptides, data.proteinSeq, config]);

  // Run the pending output action after React has committed the fixed layout.
  useEffect(() => {
    if (!outputAction) return;
    let cancelled = false;
    const id = requestAnimationFrame(async () => {
      try {
        let base = sanitizeFilename(config.titleText);
        if (config.addDatetimeToFilename) base = `${base}_${datetimeSuffix()}`;

        if (outputAction === 'print') {
          // Browsers embed document.title as the PDF's title metadata when printing to "Save
          // as PDF" — without this, every exported PDF would show the static "PeptideStudio"
          // page title (from index.html) instead of the actual figure/file name. Restore the
          // app's normal title once the print dialog closes.
          const prevTitle = document.title;
          if (base) document.title = base;
          window.print();
          document.title = prevTitle;
        } else {
          await exportAll(
            base,
            outputAction,
            config.pngDpi,
            document.querySelector<HTMLElement>('.main') ?? document.body,
            config.page.margins * PT_PER_MM,
          );
        }
      } catch (e) {
        if (!cancelled) setExportMsg(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setOutputAction(null);
      }
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [outputAction, config.titleText, config.addDatetimeToFilename, config.pngDpi]);

  const [pw, ph] = pageDimsMm(config);

  // In the fixed print/export layout, give Figures the printable box (page minus margins) in
  // points so it can shrink any oversized page to fit the sheet — the catch-all that keeps
  // any page size / font size / residues-per-row from cropping the figure.
  const fitPage = useFixedLayout
    ? {
        w: Math.max(1, (pw - 2 * config.page.margins) * PT_PER_MM),
        h: Math.max(1, (ph - 2 * config.page.margins) * PT_PER_MM),
      }
    : undefined;

  return (
    <div className="app">
      <style>{`@page { size: ${pw}mm ${ph}mm; margin: ${config.page.margins}mm; }`}</style>

      <aside className="panel">
        <h1>
          <img className="logo" src={logoLight} alt="PeptideStudio" />
        </h1>
        <DataInputs data={data} setData={setData} config={config} />
        <ConfigPanel config={config} peptides={peptides} proteinSeq={data.proteinSeq} />
      </aside>

      <main className="main" ref={mainRef}>
        <div className="toolbar">
          <button className="primary" onClick={() => setOutputAction('print')} disabled={!!outputAction}>
            🖨 Print
          </button>
          <button onClick={() => setOutputAction('png')} disabled={!!outputAction}>
            Export PNG
          </button>
          <button onClick={() => setOutputAction('jpeg')} disabled={!!outputAction}>
            Export JPEG
          </button>
          <button onClick={() => setOutputAction('svg')} disabled={!!outputAction}>
            Export SVG
          </button>
          <button onClick={() => setOutputAction('eps')} disabled={!!outputAction}>
            Export EPS
          </button>
          <label className="cb" style={{ alignSelf: 'center' }}>
            <input
              type="checkbox"
              checked={config.printPreview}
              onChange={(e) => setConfig({ printPreview: e.target.checked })}
            />
            Print preview
          </label>
          {outputAction && <span className="muted">Preparing {outputAction}…</span>}
          <label className="muted" style={{ alignSelf: 'center' }}>
            DPI (PNG/JPEG){' '}
            <input
              type="number"
              min={72}
              max={1200}
              step={72}
              value={config.pngDpi}
              style={{ width: 70 }}
              onChange={(e) =>
                setConfig({ pngDpi: Math.min(1200, Math.max(72, parseInt(e.target.value, 10) || 600)) })
              }
            />
          </label>
          <label className="muted" style={{ alignSelf: 'center' }}>
            <input
              type="checkbox"
              checked={config.addDatetimeToFilename}
              onChange={(e) => setConfig({ addDatetimeToFilename: e.target.checked })}
            />{' '}
            date in filename
          </label>
          {exportMsg && <span className="error">{exportMsg}</span>}
        </div>

        <Figures
          proteinSeq={data.proteinSeq}
          peptides={peptides}
          config={config}
          residuesPerRow={residuesPerRow}
          fitPage={fitPage}
        />

        {report && (
          <RemovedPeptides
            removed={report.removed}
            displayedCount={report.displayed}
            totalCount={report.total}
            scale={report.scale}
            config={config}
          />
        )}
      </main>
    </div>
  );
}
