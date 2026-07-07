// Convert a rendered page <svg> to Encapsulated PostScript (EPS) — a true vector format
// suited to publication figures. The app's SVG is built from a small, fully controlled set
// of primitives (rect / line / text in absolute viewBox coordinates), so we translate those
// directly to PostScript rather than parsing arbitrary SVG.
//
// PostScript's origin is bottom-left with y pointing up, whereas SVG is top-left y-down, so
// every y is flipped via `H - y`. Fonts are mapped to the core Helvetica family (the safe,
// universally available PostScript sans) since the configured UI font may not exist on a
// PostScript interpreter. Alpha is approximated by blending the colour toward white, as EPS
// (PostScript level 2) has no native constant-alpha fill.

interface RGB {
  r: number;
  g: number;
  b: number;
}

const BLACK: RGB = { r: 0, g: 0, b: 0 };

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Parse a CSS colour (#rgb, #rrggbb, rgb()/rgba(), or the few named colours we emit). */
function parseColor(input: string | null): RGB | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (s === 'none' || s === 'transparent') return null;
  if (s === 'white') return { r: 1, g: 1, b: 1 };
  if (s === 'black') return BLACK;
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16) / 255,
        g: parseInt(hex[1] + hex[1], 16) / 255,
        b: parseInt(hex[2] + hex[2], 16) / 255,
      };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
      };
    }
    return null;
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map((p) => p.trim());
    const chan = (p: string) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / 255);
    return { r: clamp01(chan(parts[0])), g: clamp01(chan(parts[1])), b: clamp01(chan(parts[2])) };
  }
  return null;
}

/** Approximate constant alpha over a white page by blending toward white. */
function blendOverWhite(c: RGB, alpha: number): RGB {
  const a = clamp01(alpha);
  return { r: c.r * a + (1 - a), g: c.g * a + (1 - a), b: c.b * a + (1 - a) };
}

function ps(n: number): string {
  // Trim to 3 decimals and drop trailing zeros to keep the output compact.
  return (Math.round(n * 1000) / 1000).toString();
}

function color(c: RGB): string {
  return `${ps(c.r)} ${ps(c.g)} ${ps(c.b)} setrgbcolor`;
}

/** Escape a string for a PostScript literal `(...)`. */
function escapePs(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function fontFor(family: string | null, weight: string | null): string {
  const bold = weight === 'bold' || weight === '700' || (weight ? parseInt(weight, 10) >= 600 : false);
  const italic = (family ?? '').toLowerCase().includes('italic');
  if (bold && italic) return 'Helvetica-BoldOblique';
  if (bold) return 'Helvetica-Bold';
  if (italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

function num(el: Element, attr: string, fallback = 0): number {
  const v = el.getAttribute(attr);
  if (v == null || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build the EPS document for one page SVG. `marginPt` adds symmetric whitespace (in points)
 * around the figure so the content is inset from the bounding-box edges — matching the page
 * margins used for print, rather than sitting flush against the top/right of a tight box.
 */
export function svgToEpsString(svg: SVGSVGElement, marginPt = 0): string {
  const vb = svg.viewBox.baseVal;
  const W = vb && vb.width ? vb.width : svg.width.baseVal.value || 800;
  const H = vb && vb.height ? vb.height : svg.height.baseVal.value || 600;
  const m = Math.max(0, marginPt);
  const flipY = (y: number) => H - y;

  const body: string[] = [];

  // Opaque white background covering the full bounding box (content + margins) so the figure
  // matches the on-screen/printed white page rather than showing through as transparent when
  // placed on a coloured background. Drawn before the margin translate so it fills the margins.
  body.push('1 1 1 setrgbcolor');
  body.push(`0 0 ${ps(W + 2 * m)} ${ps(H + 2 * m)} rectfill`);
  // Inset the content by the margin on all sides (PostScript y-up, so this shifts up + right).
  if (m > 0) body.push(`${ps(m)} ${ps(m)} translate`);

  // Walk elements in document order so paint order (z-order) is preserved. Skip on-screen-only
  // affordances (e.g. the legend resize handle) and anything nested inside them.
  const all = svg.querySelectorAll('rect, line, text');
  all.forEach((el) => {
    if (el.closest('[data-ui-only]')) return;
    const tag = el.tagName.toLowerCase();
    const opacity = el.hasAttribute('opacity') ? num(el, 'opacity', 1) : 1;

    if (tag === 'rect') {
      const x = num(el, 'x');
      const y = num(el, 'y');
      const w = num(el, 'width');
      const h = num(el, 'height');
      let fill = parseColor(el.getAttribute('fill'));
      const stroke = parseColor(el.getAttribute('stroke'));
      const sw = num(el, 'stroke-width', 1);
      // rect y is the top edge; PostScript rectangles are addressed from the bottom-left corner.
      const py = flipY(y + h);
      if (fill) {
        if (opacity < 1) fill = blendOverWhite(fill, opacity);
        body.push(color(fill));
        body.push(`${ps(x)} ${ps(py)} ${ps(w)} ${ps(h)} rectfill`);
      }
      if (stroke) {
        body.push(color(stroke));
        body.push(`${ps(sw)} setlinewidth`);
        // Reset any dash left over from a preceding dashed line so box outlines stay solid.
        body.push('[] 0 setdash');
        body.push(`${ps(x)} ${ps(py)} ${ps(w)} ${ps(h)} rectstroke`);
      }
    } else if (tag === 'line') {
      const stroke = parseColor(el.getAttribute('stroke'));
      if (!stroke) return;
      const x1 = num(el, 'x1');
      const y1 = num(el, 'y1');
      const x2 = num(el, 'x2');
      const y2 = num(el, 'y2');
      const sw = num(el, 'stroke-width', 1);
      const dash = el.getAttribute('stroke-dasharray');
      body.push(color(opacity < 1 ? blendOverWhite(stroke, opacity) : stroke));
      body.push(`${ps(sw)} setlinewidth`);
      if (dash) {
        const nums = dash.split(/[ ,]+/).map((d) => ps(parseFloat(d))).filter((d) => d !== 'NaN');
        body.push(`[${nums.join(' ')}] 0 setdash`);
      } else {
        body.push('[] 0 setdash');
      }
      body.push(`newpath ${ps(x1)} ${ps(flipY(y1))} moveto ${ps(x2)} ${ps(flipY(y2))} lineto stroke`);
    } else if (tag === 'text') {
      const text = (el.textContent ?? '').trim();
      if (!text) return;
      const x = num(el, 'x');
      const y = num(el, 'y');
      const size = num(el, 'font-size', 10);
      const fill = parseColor(el.getAttribute('fill')) ?? BLACK;
      const anchor = el.getAttribute('text-anchor') ?? 'start';
      const font = fontFor(el.getAttribute('font-family'), el.getAttribute('font-weight'));
      // text-anchor start/middle/end -> shift the current point by 0 / half / full string width.
      const factor = anchor === 'middle' ? 0.5 : anchor === 'end' ? 1 : 0;
      body.push(color(opacity < 1 ? blendOverWhite(fill, opacity) : fill));
      body.push(`/${font} findfont ${ps(size)} scalefont setfont`);
      body.push(`${ps(x)} ${ps(flipY(y))} moveto`);
      const str = `(${escapePs(text)})`;
      if (factor > 0) body.push(`${str} dup stringwidth pop ${ps(factor)} mul neg 0 rmoveto show`);
      else body.push(`${str} show`);
    }
  });

  const bbW = W + 2 * m;
  const bbH = H + 2 * m;
  const header = [
    '%!PS-Adobe-3.0 EPSF-3.0',
    `%%BoundingBox: 0 0 ${Math.ceil(bbW)} ${Math.ceil(bbH)}`,
    `%%HiResBoundingBox: 0 0 ${ps(bbW)} ${ps(bbH)}`,
    '%%Creator: PeptideStudio',
    '%%Title: Peptide coverage figure',
    '%%LanguageLevel: 2',
    '%%EndComments',
    '%%Page: 1 1',
    'gsave',
  ];
  const footer = ['grestore', '%%EOF'];
  return [...header, ...body, ...footer].join('\n') + '\n';
}

export function epsBlob(svg: SVGSVGElement, marginPt = 0): Blob {
  return new Blob([svgToEpsString(svg, marginPt)], { type: 'application/postscript' });
}
