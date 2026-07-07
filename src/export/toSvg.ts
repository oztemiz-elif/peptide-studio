// Serialize rendered <svg> page elements to standalone SVG strings.

export interface ExportedPage {
  id: string;
  svg: SVGSVGElement;
}

/** Collect every rendered page SVG along with its export id. */
export function collectPages(root: HTMLElement = document.body): ExportedPage[] {
  const out: ExportedPage[] = [];
  root.querySelectorAll<HTMLElement>('[data-export-id]').forEach((el) => {
    const svg = el.querySelector('svg');
    if (svg) out.push({ id: el.dataset.exportId ?? 'page', svg });
  });
  return out;
}

export function svgToString(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  // Drop on-screen-only affordances (e.g. the legend resize handle) so they never appear
  // in exported SVG/PNG files.
  clone.querySelectorAll('[data-ui-only]').forEach((el) => el.remove());
  const xml = new XMLSerializer().serializeToString(clone);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
}

export function svgBlob(svg: SVGSVGElement): Blob {
  return new Blob([svgToString(svg)], { type: 'image/svg+xml;charset=utf-8' });
}
