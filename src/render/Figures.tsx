// Builds the layout and renders every figure as a sequence of print pages.
// Each page is a .page div (CSS handles page breaks) holding one SVG.

import { useMemo } from 'react';
import { Config } from '../state/config';
import { Peptide } from '../model/peptides';
import { buildLayout } from '../model/layout';
import { drawPage, pageCount } from './draw';
import { PrimSvg } from './PrimSvg';

interface Props {
  proteinSeq: string;
  peptides: Peptide[];
  config: Config;
  /** Override residues-per-row (responsive mode passes the width-derived value). */
  residuesPerRow?: number;
  /**
   * Printable page box in points (page size minus margins) for the fixed print/export
   * layout. When set, every page is uniformly scaled down (never up) to fit this box, so no
   * page size, font size, or residues-per-row can crop the content. Omitted in the responsive
   * on-screen view, which sizes to the browser instead of a sheet.
   */
  fitPage?: { w: number; h: number };
}

/** data-export-id is used by the export module to find each page's <svg>. */
export function Figures({ proteinSeq, peptides, config, residuesPerRow, fitPage }: Props) {
  const layout = useMemo(
    () => buildLayout(proteinSeq, peptides, config, residuesPerRow),
    [proteinSeq, peptides, config, residuesPerRow],
  );

  // Draw every page up front so we can derive one shared fit scale: a page must fit both the
  // printable width and height, and all pages share the smallest scale any page needs so the
  // whole document prints at a single consistent size (rather than each page shrinking differently).
  const drawnFigures = useMemo(
    () =>
      layout.figures.map((figure, fi) =>
        Array.from({ length: pageCount(figure) }, (_, pi) =>
          drawPage(figure, pi, proteinSeq, config, `fig${fi + 1}_page${pi + 1}`),
        ),
      ),
    [layout, proteinSeq, config],
  );

  const fitScale = useMemo(() => {
    if (!fitPage) return 1;
    let s = 1;
    for (const pages of drawnFigures) {
      for (const d of pages) {
        if (d.width > 0) s = Math.min(s, fitPage.w / d.width);
        if (d.height > 0) s = Math.min(s, fitPage.h / d.height);
      }
    }
    return s > 0 && s < 1 ? s : 1;
  }, [drawnFigures, fitPage]);

  if (!proteinSeq) {
    return <p className="hint">Provide a protein sequence to render the visualization.</p>;
  }
  if (peptides.length === 0) {
    return <p className="hint">No peptides parsed yet — map start/end and intensity columns.</p>;
  }

  return (
    <div className="figures">
      {layout.figures.map((figure, fi) => {
        const pages = pageCount(figure);
        return (
          <section className="figure" key={fi}>
            {Array.from({ length: pages }, (_, pi) => {
              const id = `fig${fi + 1}_page${pi + 1}`;
              const drawn = drawnFigures[fi][pi];
              return (
                <div className="page" key={pi} data-export-id={id}>
                  <PrimSvg
                    page={drawn}
                    legendOffset={config.legendOffsets[id] ?? { x: 0, y: 0 }}
                    legendScale={config.legendScales[id] ?? 1}
                    fitScale={fitScale}
                  />
                  {pages > 1 && (
                    <div className="page-footer">
                      Figure {fi + 1} · page {pi + 1} / {pages}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
