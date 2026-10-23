// Renders a DrawnPage (geometry primitives) into an <svg>. The legend group is
// draggable: pointer events on it translate into config.legendOffsets[page.legendId]
// updates so the box can be moved off of obstructed data. Double-click resets that
// page's legend back to its default corner.

import { forwardRef, useRef } from 'react';
import { CENTER_BASELINE_RATIO, DrawnPage, Prim } from './draw';
import { setConfig } from '../state/store';

function renderPrim(p: Prim, i: number) {
  switch (p.k) {
    case 'rect':
      return (
        <rect
          key={i}
          x={p.x}
          y={p.y}
          width={p.w}
          height={p.h}
          fill={p.fill ?? 'none'}
          stroke={p.stroke}
          strokeWidth={p.sw}
          opacity={p.opacity}
        />
      );
    case 'line':
      return (
        <line
          key={i}
          x1={p.x1}
          y1={p.y1}
          x2={p.x2}
          y2={p.y2}
          stroke={p.stroke}
          strokeWidth={p.sw}
          strokeDasharray={p.dash}
          opacity={p.opacity}
        />
      );
    case 'text':
      return (
        <text
          key={i}
          x={p.x}
          // Vertical centering is baked into the baseline `y` rather than expressed via
          // `dominant-baseline: central`, because Microsoft Word/Office's SVG renderer
          // ignores `dominant-baseline` entirely — every centered glyph would otherwise
          // fall back to the alphabetic baseline on import, scrambling the text alignment.
          // The default (alphabetic) baseline is honored everywhere, so we shift y down by
          // ~0.356·fontSize (half the cap height — measured to match the old `central`
          // rendering exactly) to put a capital letter/digit's visual centre on p.y.
          y={p.center ? p.y + p.size * CENTER_BASELINE_RATIO : p.y}
          fontSize={p.size}
          textAnchor={p.anchor}
          fontWeight={p.weight}
          fontFamily={p.family}
          fill={p.fill ?? '#000'}
        >
          {p.text}
        </text>
      );
  }
}

interface Props {
  page: DrawnPage;
  className?: string;
  /** Current offset for this page's legend (config.legendOffsets[page.legendId]). */
  legendOffset?: { x: number; y: number };
  /** Current size multiplier for this page's legend (config.legendScales[page.legendId]). */
  legendScale?: number;
  /**
   * Uniform display scale (≤ 1) applied to the physical width/height of the SVG so a page
   * whose content would otherwise be wider/taller than the printable sheet is shrunk to fit
   * (print/export only). The viewBox is left at the content's natural size, so coordinates,
   * legend dragging, and text stay correct — only the rendered pt dimensions shrink. 1 keeps
   * the natural 1:1 size (the common case once auto-size-to-page has already fit the content).
   */
  fitScale?: number;
}

export const PrimSvg = forwardRef<SVGSVGElement, Props>(function PrimSvg(
  { page, className, legendOffset, legendScale = 1, fitScale = 1 },
  ref,
) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  );
  const resize = useRef<{ pointerId: number; brx: number; bry: number; startDist: number; startScale: number } | null>(
    null,
  );

  function setRefs(el: SVGSVGElement | null) {
    svgRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) (ref as React.MutableRefObject<SVGSVGElement | null>).current = el;
  }

  /** Pointer position in SVG user units (the viewBox is 0,0..page.width,page.height). */
  function svgPoint(e: React.PointerEvent): { x: number; y: number } {
    const rect = svgRef.current!.getBoundingClientRect();
    const k = page.width / rect.width;
    return { x: (e.clientX - rect.left) * k, y: (e.clientY - rect.top) * k };
  }

  function handlePointerDown(e: React.PointerEvent<SVGGElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: legendOffset?.x ?? 0,
      baseY: legendOffset?.y ?? 0,
    };
  }

  function handlePointerMove(e: React.PointerEvent<SVGGElement>) {
    const d = drag.current;
    const legendId = page.legendId;
    if (!d || d.pointerId !== e.pointerId || !svgRef.current || !legendId) return;
    // Convert on-screen pixel movement to SVG user units via the viewBox/rendered-size ratio,
    // so dragging tracks the cursor correctly at any zoom/print scale.
    const rect = svgRef.current.getBoundingClientRect();
    const scale = page.width / rect.width;
    const dx = (e.clientX - d.startX) * scale;
    const dy = (e.clientY - d.startY) * scale;
    const x = Math.round(d.baseX + dx);
    const y = Math.round(d.baseY + dy);
    setConfig((c) => ({ legendOffsets: { ...c.legendOffsets, [legendId]: { x, y } } }));
  }

  function handlePointerUp(e: React.PointerEvent<SVGGElement>) {
    if (drag.current?.pointerId === e.pointerId) drag.current = null;
  }

  // --- resize (drag the handle at the legend's top-left corner) ---
  function handleResizeDown(e: React.PointerEvent<SVGGElement>) {
    e.stopPropagation(); // don't also start a move on the legend group
    const box = page.legendBox;
    if (!page.legendId || !box || !svgRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const brx = box.x + box.w; // bottom-right anchor stays fixed while resizing
    const bry = box.y + box.h;
    const p = svgPoint(e);
    resize.current = {
      pointerId: e.pointerId,
      brx,
      bry,
      startDist: Math.hypot(p.x - brx, p.y - bry) || 1,
      startScale: legendScale,
    };
  }

  function handleResizeMove(e: React.PointerEvent<SVGGElement>) {
    const r = resize.current;
    const legendId = page.legendId;
    if (!r || r.pointerId !== e.pointerId || !legendId || !svgRef.current) return;
    const p = svgPoint(e);
    const dist = Math.hypot(p.x - r.brx, p.y - r.bry);
    // Scale tracks the handle's distance from the fixed bottom-right corner.
    const next = Math.max(0.4, Math.min(4, (r.startScale * dist) / r.startDist));
    setConfig((c) => ({ legendScales: { ...c.legendScales, [legendId]: Math.round(next * 100) / 100 } }));
  }

  function handleResizeUp(e: React.PointerEvent<SVGGElement>) {
    if (resize.current?.pointerId === e.pointerId) resize.current = null;
  }

  // Double-click the legend to reset both its position and size.
  function handleDoubleClick() {
    const legendId = page.legendId;
    if (!legendId) return;
    setConfig((c) => {
      const offsets = { ...c.legendOffsets };
      const scales = { ...c.legendScales };
      const had = legendId in offsets || legendId in scales;
      delete offsets[legendId];
      delete scales[legendId];
      return had ? { legendOffsets: offsets, legendScales: scales } : {};
    });
  }

  return (
    <svg
      ref={setRefs}
      className={className}
      // Physical size in points so 1 user unit == 1 pt: a font-size of N renders as N pt
      // in printed/PDF output (avoids the px→pt 0.75 shrink, e.g. 9 showing as 6.75).
      // fitScale (≤1) uniformly shrinks the pt dimensions so an oversized page fits the sheet
      // instead of being cropped; the viewBox stays natural so all coordinates are unchanged.
      width={`${page.width * fitScale}pt`}
      height={`${page.height * fitScale}pt`}
      viewBox={`0 0 ${page.width} ${page.height}`}
      xmlns="http://www.w3.org/2000/svg"
      style={{ maxWidth: '100%', height: 'auto', background: '#fff' }}
    >
      {page.prims.map(renderPrim)}
      {/*
        Always render this <g>, even with no legend — conditionally mounting/unmounting it
        (the previous `{page.legend && <g>...</g>}`) crashed React's reconciler with a
        "removeChild: node is not a child of this node" error whenever the SAME render also
        changed the length of the keyed `page.prims` list above it (e.g. editing manual page
        breaks reshuffles the layout and the previously-last page, which had a legend, is no
        longer last). Keeping the <g> permanently in the tree and only swapping its (empty)
        content sidesteps that reconciliation bug entirely.
      */}
      <g
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        style={{ cursor: page.legend ? 'move' : 'default' }}
      >
        {(page.legend ?? []).map(renderPrim)}
        {page.legend && page.legendBox && (() => {
          // Resize handle at the legend's top-left corner. `data-ui-only` marks it as an
          // on-screen affordance that export (toSvg) and print (print.css) strip out.
          const b = page.legendBox;
          const h = Math.max(8, Math.min(18, Math.min(b.w, b.h) * 0.18));
          return (
            <g
              data-ui-only="1"
              onPointerDown={handleResizeDown}
              onPointerMove={handleResizeMove}
              onPointerUp={handleResizeUp}
              style={{ cursor: 'nwse-resize' }}
            >
              <rect x={b.x} y={b.y} width={h} height={h} fill="#2563eb" opacity={0.85} rx={1} />
              <line x1={b.x + h * 0.28} y1={b.y + h * 0.72} x2={b.x + h * 0.72} y2={b.y + h * 0.28} stroke="#fff" strokeWidth={Math.max(0.8, h * 0.09)} />
              <line x1={b.x + h * 0.5} y1={b.y + h * 0.72} x2={b.x + h * 0.72} y2={b.y + h * 0.5} stroke="#fff" strokeWidth={Math.max(0.8, h * 0.09)} />
            </g>
          );
        })()}
      </g>
    </svg>
  );
});
