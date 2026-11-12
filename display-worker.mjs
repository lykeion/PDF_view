// Display-only refinement of opaque PDF page pixels. The source is never
// changed. Keep the separable horizontal pass to a small sliding row cache,
// instead of allocating another full-resolution floating-point image.
const MAX_SOURCE_PIXELS = 24_000_000;
const MAX_OUTPUT_PIXELS = 12_000_000;
const clamp = value => Math.max(0, Math.min(255, Math.round(value)));
const strengthOf = value => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
function smoothstep(low, high, value) {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}
function luminanceRow(pixels, width, row) {
  const values = new Float32Array(width);
  let offset = row * width * 4;
  for (let x = 0; x < width; x++, offset += 4) values[x] = .2126 * pixels[offset] + .7152 * pixels[offset + 1] + .0722 * pixels[offset + 2];
  return values;
}

function reinforceStrokeRow(source, width, height, y, amount, row) {
  const lightAt = (x, rowY) => {
    const offset = (Math.max(0, Math.min(height - 1, rowY)) * width + Math.max(0, Math.min(width - 1, x))) * 4;
    return .2126 * source[offset] + .7152 * source[offset + 1] + .0722 * source[offset + 2];
  };
  for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    const red = source[offset], green = source[offset + 1], blue = source[offset + 2];
    const light = .2126 * red + .7152 * green + .0722 * blue;
    const neutral = 1 - smoothstep(6, 24, Math.max(red, green, blue) - Math.min(red, green, blue));
    let best = 0, inkX = x, inkY = y, inkLight = light;
    if (neutral && light > 48) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        const neighbor = ((y + dy) * width + x + dx) * 4;
        const r = source[neighbor], g = source[neighbor + 1], b = source[neighbor + 2];
        const darker = .2126 * r + .7152 * g + .0722 * b;
        const difference = light - darker;
        if (difference <= 10 || darker >= 216) continue;
        const grayInk = 1 - smoothstep(6, 24, Math.max(r, g, b) - Math.min(r, g, b));
        const candidate = .1 * difference * smoothstep(10, 40, difference) * grayInk *
          (1 - smoothstep(152, 216, darker)) * (dx && dy ? .5 : 1);
        if (candidate > best) { best = candidate; inkX = x + dx; inkY = y + dy; inkLight = darker; }
      }
    }
    // A candidate must have lighter paper on both sides of at least one axis.
    // This favors thin native strokes over the edges of broad filled shapes.
    const across = best ? Math.max(
      Math.min(lightAt(inkX - 2, inkY), lightAt(inkX + 2, inkY)),
      Math.min(lightAt(inkX, inkY - 2), lightAt(inkX, inkY + 2))) - inkLight : 0;
    const delta = Math.min(12, best) * amount * neutral * smoothstep(48, 176, light) * smoothstep(10, 48, across);
    // At maximum strength even a white gap stays at least 243 before shrinking.
    // Never rewrite source pixels or expand a black mask into neighboring ink.
    row[x * 3] = red - delta; row[x * 3 + 1] = green - delta; row[x * 3 + 2] = blue - delta;
  }
}

function adjustReadingTones(pixels, width, height, density, cleanup) {
  const ink = density / 100, paper = cleanup / 100;
  if (!ink && !paper) return;
  // Keep the original neighboring luminance while writing this output row.
  // Cleanup is deliberately conservative: a dark local ridge may be a very
  // faint character, so protect it instead of trying to identify scan noise.
  let current = paper ? luminanceRow(pixels, width, 0) : null;
  let previous = current, next = paper ? luminanceRow(pixels, width, Math.min(1, height - 1)) : null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const red = pixels[offset], green = pixels[offset + 1], blue = pixels[offset + 2];
      const light = current ? current[x] : .2126 * red + .7152 * green + .0722 * blue;
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      const neutral = 1 - smoothstep(6, 24, chroma);
      if (!neutral) continue;
      const tone = light / 255;
      // A smooth, bounded midtone curve: black, white, and the pale-paper
      // range remain untouched. No dilation that could join Korean strokes.
      let delta = -16 * ink * 4 * tone * (1 - tone) * smoothstep(8, 40, light) * (1 - smoothstep(176, 224, light));
      if (paper && light > 232) {
        const left = Math.max(0, x - 1), right = Math.min(width - 1, x + 1);
        const localMean = (previous[left] + previous[x] + previous[right] +
          current[left] + current[x] + current[right] + next[left] + next[x] + next[right]) / 9;
        const strokeProtection = 1 - smoothstep(.25, 1.5, localMean - light);
        delta += .8 * paper * (255 - light) * smoothstep(232, 250, light) * strokeProtection;
      }
      delta *= neutral;
      for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = clamp(pixels[offset + channel] + delta);
    }
    if (paper) {
      previous = current; current = next;
      next = y + 2 < height ? luminanceRow(pixels, width, y + 2) : current;
    }
  }
}
function lanczos2(x) {
  x = Math.abs(x);
  if (x < 1e-8) return 1;
  if (x >= 2) return 0;
  const p = Math.PI * x;
  return Math.sin(p) * Math.sin(p / 2) / (p * p / 2);
}
function contributors(sourceSize, targetSize) {
  const scale = sourceSize / targetSize, footprint = Math.max(1, scale);
  return Array.from({length: targetSize}, (_, target) => {
    const center = (target + .5) * scale - .5;
    const start = Math.max(0, Math.ceil(center - 2 * footprint));
    const end = Math.min(sourceSize - 1, Math.floor(center + 2 * footprint));
    const weights = new Float32Array(end - start + 1);
    let total = 0;
    for (let sample = start; sample <= end; sample++) {
      const weight = lanczos2((sample - center) / footprint);
      weights[sample - start] = weight; total += weight;
    }
    for (let i = 0; i < weights.length; i++) weights[i] /= total;
    return {start, weights};
  });
}
function sharpen(pixels, width, height, strength) {
  const amount = .75 * strength / 100, maxDelta = 24 * strength / 100;
  if (!amount || width < 2 || height < 2) return;
  let current = luminanceRow(pixels, width, 0), previous = current;
  let next = luminanceRow(pixels, width, 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - 1), right = Math.min(width - 1, x + 1);
      const blur = (previous[left] + 2 * previous[x] + previous[right] +
        2 * current[left] + 4 * current[x] + 2 * current[right] +
        next[left] + 2 * next[x] + next[right]) / 16;
      const detail = current[x] - blur;
      // Ignore near-flat scan grain. Bound the correction so stronger settings
      // cannot turn faint texture into a large bright/dark halo.
      const delta = Math.max(-maxDelta, Math.min(maxDelta,
        Math.sign(detail) * Math.max(0, Math.abs(detail) - .8) * amount));
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = clamp(pixels[offset + channel] + delta);
    }
    previous = current; current = next;
    next = y + 2 < height ? luminanceRow(pixels, width, y + 2) : current;
  }
}

export function resampleRgba(source, sourceWidth, sourceHeight, width, height, sharpness = 25, {density = 0, cleanup = 0, stroke = 0} = {}) {
  if (![sourceWidth, sourceHeight, width, height].every(value => Number.isInteger(value) && value > 0) ||
      sourceWidth * sourceHeight > MAX_SOURCE_PIXELS || width * height > MAX_OUTPUT_PIXELS ||
      width > sourceWidth + 1 || height > sourceHeight + 1 || source.length !== sourceWidth * sourceHeight * 4) {
    throw new RangeError('Unsupported display raster size.');
  }
  const strength = Number.isFinite(sharpness) ? Math.max(0, Math.min(100, sharpness)) : 25;
  const strokeAmount = width <= sourceWidth && height <= sourceHeight && (width < sourceWidth || height < sourceHeight) ? strengthOf(stroke) / 100 : 0;
  const output = new Uint8ClampedArray(width * height * 4);
  if (sourceWidth === width && sourceHeight === height) output.set(source);
  else {
    const horizontal = contributors(sourceWidth, width), vertical = contributors(sourceHeight, height);
    const rows = new Map();
    // One reusable native-resolution row is enough; no second source image.
    const nativeRow = strokeAmount ? new Float32Array(sourceWidth * 3) : null;
    function rowAt(y) {
      if (rows.has(y)) return rows.get(y);
      if (nativeRow) reinforceStrokeRow(source, sourceWidth, sourceHeight, y, strokeAmount, nativeRow);
      const row = new Float32Array(width * 3);
      for (let x = 0; x < width; x++) {
        const {start, weights} = horizontal[x];
        let red = 0, green = 0, blue = 0;
        for (let sample = 0; sample < weights.length; sample++) {
          const offset = nativeRow ? (start + sample) * 3 : (y * sourceWidth + start + sample) * 4, weight = weights[sample];
          const input = nativeRow || source;
          red += input[offset] * weight; green += input[offset + 1] * weight; blue += input[offset + 2] * weight;
        }
        row[x * 3] = red; row[x * 3 + 1] = green; row[x * 3 + 2] = blue;
      }
      rows.set(y, row); return row;
    }
    const accumulated = new Float32Array(width * 3);
    for (let y = 0; y < height; y++) {
      accumulated.fill(0);
      const {start, weights} = vertical[y];
      for (let sample = 0; sample < weights.length; sample++) {
        const row = rowAt(start + sample), weight = weights[sample];
        for (let i = 0; i < row.length; i++) accumulated[i] += row[i] * weight;
      }
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        output[offset] = clamp(accumulated[x * 3]); output[offset + 1] = clamp(accumulated[x * 3 + 1]); output[offset + 2] = clamp(accumulated[x * 3 + 2]); output[offset + 3] = 255;
      }
      const nextStart = vertical[y + 1]?.start ?? sourceHeight;
      for (const row of rows.keys()) if (row < nextStart) rows.delete(row);
    }
  }
  // Tone changes precede the final, bounded acutance correction. The original
  // raster and downsampling inputs are never modified by these controls.
  adjustReadingTones(output, width, height, strengthOf(density), strengthOf(cleanup));
  sharpen(output, width, height, strength);
  return output;
}

// This module also exports its pure kernel for numerical regression checks.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
  self.onmessage = event => {
    const {id, bitmap, width, height, sharpness} = event.data;
    const density = strengthOf(event.data.density), cleanup = strengthOf(event.data.cleanup), stroke = strengthOf(event.data.stroke);
    let surface;
    try {
      const started = performance.now();
      surface = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = surface.getContext('2d', {alpha: false, willReadFrequently: true});
      context.drawImage(bitmap, 0, 0);
      let source = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const sourceWidth = bitmap.width, sourceHeight = bitmap.height;
      bitmap.close(); surface.width = 0; surface.height = 0;
      const strokeApplied = stroke > 0 && width <= sourceWidth && height <= sourceHeight && (width < sourceWidth || height < sourceHeight);
      const pixels = resampleRgba(source.data, sourceWidth, sourceHeight, width, height, sharpness, {density, cleanup, stroke});
      source = null;
      surface = new OffscreenCanvas(width, height);
      surface.getContext('2d', {alpha: false}).putImageData(new ImageData(pixels, width, height), 0, 0);
      const result = surface.transferToImageBitmap();
      const method = `lanczos2${strokeApplied ? '+stroke' : ''}${density ? '+density' : ''}${cleanup ? '+cleanup' : ''}${sharpness > 0 ? '+unsharp' : ''}`;
      self.postMessage({id, bitmap: result, method, density, cleanup, stroke, strokeApplied, elapsed: performance.now() - started}, [result]);
    } catch (error) {
      bitmap?.close(); self.postMessage({id, error: error?.message || 'Unable to refine page.'});
    } finally {
      if (surface) { surface.width = 0; surface.height = 0; }
    }
  };
}
