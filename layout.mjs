export function spreadStart(page, count, mode = 'spread', cover = false) {
  const p = Math.max(1, Math.min(count || 1, Math.trunc(Number(page) || 1)));
  if (mode === 'single' || (cover && p === 1)) return p;
  return cover ? p - (p % 2) : p - ((p - 1) % 2);
}

export function spreadPages(start, count, mode = 'spread', cover = false) {
  const first = spreadStart(start, count, mode, cover);
  return mode === 'single' || (cover && first === 1) || first === count
    ? [first] : [first, first + 1];
}

export function calculateLayout(pages, {mode = 'frame', fit = 'page', zoom = 1,
  availableWidth = 1000, availableHeight = 800, reference = pages[0], gap = 20} = {}) {
  if (!pages.length) return {width: 0, height: 0, pages: [], baseScale: 1};
  const refW = Math.max(1, reference.width), refH = Math.max(1, reference.height);
  const normalized = pages.map(({width, height}) => {
    let scale = 1, w = width, h = height;
    if (mode === 'height') { scale = refH / height; w *= scale; h = refH; }
    if (mode === 'frame') { scale = Math.min(refW / width, refH / height); w = refW; h = refH; }
    return {width: w, height: h, scale, contentWidth: width * scale, contentHeight: height * scale};
  });
  const gapWidth = gap * (pages.length - 1);
  const w = normalized.reduce((n, p) => n + p.width, 0);
  const h = Math.max(...normalized.map(p => p.height));
  const widthScale = Math.max(1, availableWidth - gapWidth) / w;
  const baseScale = fit === 'width' ? widthScale : Math.min(widthScale, Math.max(1, availableHeight) / h);
  const multiplier = baseScale * Math.max(0.25, Math.min(4, Number(zoom) || 1));
  return {width: w * multiplier + gapWidth, height: h * multiplier, baseScale,
    pages: normalized.map(p => ({width: p.width * multiplier, height: p.height * multiplier,
      contentWidth: p.contentWidth * multiplier, contentHeight: p.contentHeight * multiplier,
      scale: p.scale * multiplier,
      offsetX: (p.width - p.contentWidth) * multiplier / 2,
      offsetY: (p.height - p.contentHeight) * multiplier / 2}))};
}

// Establish 100% fit from the scrollbar-independent container size, then zoom
// that baseline. Using the current client size feeds scrollbar changes back
// into fit and can make a slightly enlarged page oscillate indefinitely.
export function calculateViewportLayout(pages, {availableWidth = 1000, availableHeight = 800,
  scrollbarWidth = 0, scrollbarHeight = 0, pixelRatio = 1, zoom = 1, gap = 20, ...options} = {}) {
  let horizontal = false, vertical = false, width = availableWidth, height = availableHeight;
  for (let pass=0;pass<3;pass++) {
    width = Math.max(20,availableWidth - (vertical ? Math.max(0,scrollbarWidth) : 0));
    height = Math.max(20,availableHeight - (horizontal ? Math.max(0,scrollbarHeight) : 0));
    const fitted = alignLayoutToPixels(calculateLayout(pages,{...options,availableWidth:width,availableHeight:height,zoom:1,gap}),pixelRatio,gap);
    const nextHorizontal = horizontal || fitted.width > width + 1e-7;
    const nextVertical = vertical || fitted.height > height + 1e-7;
    if (nextHorizontal === horizontal && nextVertical === vertical) break;
    horizontal = nextHorizontal; vertical = nextVertical;
  }
  return alignLayoutToPixels(calculateLayout(pages,{...options,availableWidth:width,availableHeight:height,zoom,gap}),pixelRatio,gap);
}

// Round the final display grid, keeping equal-page frames equal. Raster pixels
// and selectable text use the same resulting rectangle.
export function alignLayoutToPixels(layout, pixelRatio = 1, gap = 20) {
  const dpr = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const snap = value => Math.round(value * dpr) / dpr;
  const fit = value => Math.floor(value * dpr + 1e-7) / dpr;
  const pages = layout.pages.map(page => {
    // Frames round inward so two independent rounding errors cannot produce
    // a horizontal scrollbar when the spread is fitted to the viewport.
    const width = Math.max(1 / dpr, fit(page.width)), height = Math.max(1 / dpr, fit(page.height));
    const contentWidth = Math.min(width, Math.max(1 / dpr, snap(page.contentWidth)));
    const contentHeight = Math.min(height, Math.max(1 / dpr, snap(page.contentHeight)));
    return {...page, width, height, contentWidth, contentHeight,
      offsetX: Math.max(0, snap((width - contentWidth) / 2)),
      offsetY: Math.max(0, snap((height - contentHeight) / 2))};
  });
  return {...layout, pages, gap: snap(gap),
    width: pages.reduce((sum,page) => sum + page.width, 0) + snap(gap) * Math.max(0, pages.length - 1),
    height: Math.max(0, ...pages.map(page => page.height))};
}
