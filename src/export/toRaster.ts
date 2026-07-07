// Rasterize an <svg> page to a PNG or JPEG blob at a chosen DPI.

import { svgToString } from './toSvg';

/**
 * Shared rasterizer: draws the SVG onto an off-screen canvas at the requested dpi (SVG user
 * units are points, 1/72") and encodes it as `mimeType`. A white background is always painted
 * first — JPEG has no alpha channel, and this also keeps PNG output consistent with the app's
 * white page rather than transparent.
 */
async function svgToRasterBlob(
  svg: SVGSVGElement,
  dpi: number,
  mimeType: 'image/png' | 'image/jpeg',
  quality?: number,
): Promise<Blob> {
  const scale = Math.max(0.5, dpi / 72);
  const vb = svg.viewBox.baseVal;
  const width = vb && vb.width ? vb.width : svg.width.baseVal.value || 800;
  const height = vb && vb.height ? vb.height : svg.height.baseVal.value || 600;

  const svgStr = svgToString(svg);
  const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }));

  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await canvasToBlob(canvas, mimeType, quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function svgToPngBlob(svg: SVGSVGElement, dpi: number): Promise<Blob> {
  return svgToRasterBlob(svg, dpi, 'image/png');
}

/** `quality` is 0-1 (JPEG compression quality); defaults to 0.92. */
export function svgToJpegBlob(svg: SVGSVGElement, dpi: number, quality = 0.92): Promise<Blob> {
  return svgToRasterBlob(svg, dpi, 'image/jpeg', quality);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to rasterize SVG'));
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), mimeType, quality);
  });
}
