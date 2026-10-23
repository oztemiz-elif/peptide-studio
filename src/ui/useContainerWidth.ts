// Tracks an element's width via ResizeObserver (drives responsive residues-per-row, and the
// width of the coverage profile).
//
// The element is held in state and attached through a callback ref rather than a RefObject, so
// the observer is set up whenever the element actually appears. With a plain ref and an
// effect that runs once, an element inside a collapsed panel is still null when the effect
// fires, and the observer is never attached — the width stays 0 for the lifetime of the
// component, however many times the panel is later opened.

import { useEffect, useState } from 'react';

export function useContainerWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [el]);

  return [setEl, width];
}
