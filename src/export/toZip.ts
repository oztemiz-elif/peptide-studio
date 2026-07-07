// Download helpers: single-file saves and multi-page ZIP bundles (mirrors the
// PNG/SVG zip behavior in main.py:2414-2481).

import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { collectPages, svgBlob, svgToString } from './toSvg';
import { svgToJpegBlob, svgToPngBlob } from './toRaster';
import { epsBlob, svgToEpsString } from './toEps';

export type Format = 'png' | 'jpeg' | 'svg' | 'eps';

/** Export all rendered pages. Single page -> direct download; multiple -> ZIP.
 *  `marginPt` insets the figure within the EPS bounding box (points); ignored for other formats. */
export async function exportAll(
  baseName: string,
  format: Format,
  dpi: number,
  root: HTMLElement = document.body,
  marginPt = 0,
): Promise<void> {
  const pages = collectPages(root);
  if (pages.length === 0) throw new Error('Nothing to export — render a figure first.');

  if (pages.length === 1) {
    const { svg } = pages[0];
    if (format === 'svg') saveAs(svgBlob(svg), `${baseName}.svg`);
    else if (format === 'eps') saveAs(epsBlob(svg, marginPt), `${baseName}.eps`);
    else if (format === 'jpeg') saveAs(await svgToJpegBlob(svg, dpi), `${baseName}.jpg`);
    else saveAs(await svgToPngBlob(svg, dpi), `${baseName}.png`);
    return;
  }

  const zip = new JSZip();
  for (const { id, svg } of pages) {
    if (format === 'svg') zip.file(`${baseName}_${id}.svg`, svgToString(svg));
    else if (format === 'eps') zip.file(`${baseName}_${id}.eps`, svgToEpsString(svg, marginPt));
    else if (format === 'jpeg') zip.file(`${baseName}_${id}.jpg`, await svgToJpegBlob(svg, dpi));
    else zip.file(`${baseName}_${id}.png`, await svgToPngBlob(svg, dpi));
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  saveAs(blob, `${baseName}_${format}_all.zip`);
}
