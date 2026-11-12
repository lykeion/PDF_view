const abortError = () => new DOMException('Display refinement superseded.', 'AbortError');
const strengthOf = value => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;

export function validateCrop(sourceWidth, sourceHeight, crop = null) {
  if (![sourceWidth, sourceHeight].every(value => Number.isInteger(value) && value > 0) || sourceWidth * sourceHeight > 24_000_000) {
    throw new RangeError('Unsupported source raster size.');
  }
  const region = crop === null ? {x: 0, y: 0, width: sourceWidth, height: sourceHeight} : {...crop};
  if (![region.x, region.y, region.width, region.height].every(Number.isInteger) || region.x < 0 || region.y < 0 ||
      region.width <= 0 || region.height <= 0 || region.x + region.width > sourceWidth || region.y + region.height > sourceHeight) {
    throw new RangeError('Crop must be a whole-pixel rectangle inside the source raster.');
  }
  return {x: region.x, y: region.y, width: region.width, height: region.height};
}

export class DisplayRasterizer {
  constructor() {
    this.worker = null; this.active = null; this.queue = []; this.nextId = 0; this.disposed = false;
  }
  render(sourceCanvas, width, height, sharpness = 25, {density = 0, cleanup = 0, stroke = 0, crop = null, isCurrent = () => true, signal} = {}) {
    if (this.disposed || signal?.aborted || !isCurrent()) return Promise.reject(abortError());
    let region;
    try { region = validateCrop(sourceCanvas.width, sourceCanvas.height, crop); }
    catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const job = {id: ++this.nextId, sourceCanvas, width, height, sharpness, density: strengthOf(density), cleanup: strengthOf(cleanup), stroke: strengthOf(stroke),
        crop: region, isCurrent, signal, resolve, reject, done: false};
      job.abort = () => this.cancel(job);
      signal?.addEventListener('abort', job.abort, {once: true});
      this.queue.push(job);
      // Visible spreads contain at most two pages. Never retain a trail of old
      // requests (or their source bitmaps) while a zoom slider is moving.
      while (this.queue.length > 2) this.finish(this.queue.shift(), null, abortError());
      void this.pump();
    });
  }
  finish(job, value, error) {
    if (!job || job.done) { if (value?.canvas) { value.canvas.width = 0; value.canvas.height = 0; } return; }
    job.done = true; job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error); else job.resolve(value);
  }
  stopWorker() { this.worker?.terminate(); this.worker = null; }
  cancel(job) {
    if (job.done) return;
    this.queue = this.queue.filter(item => item !== job);
    if (this.active === job) { this.stopWorker(); this.active = null; }
    this.finish(job, null, abortError()); void this.pump();
  }
  async pump() {
    if (this.disposed || this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    if (job.signal?.aborted || !job.isCurrent()) { this.finish(job, null, abortError()); void this.pump(); return; }
    this.active = job;
    let bitmap;
    try {
      if (typeof Worker === 'undefined' || typeof createImageBitmap === 'undefined') throw new Error('Display refinement is unavailable.');
      const region = validateCrop(job.sourceCanvas.width, job.sourceCanvas.height, job.crop);
      if (![job.width, job.height].every(value => Number.isInteger(value) && value > 0) || job.width * job.height > 12_000_000 ||
          job.width > region.width + 1 || job.height > region.height + 1) {
        throw new RangeError('Unsupported display raster size.');
      }
      // Only the active job creates a bitmap. Waiting jobs merely hold their
      // existing cached canvas, so additional full-size copies cannot pile up.
      // Copy only the selected source rectangle. The worker reads that region
      // at native resolution; pixels outside it never enter the filter.
      bitmap = await createImageBitmap(job.sourceCanvas, region.x, region.y, region.width, region.height);
      if (job.done || this.active !== job || job.signal?.aborted || !job.isCurrent()) { bitmap.close(); if (!job.done) this.cancel(job); return; }
      if (!this.worker) {
        const worker = this.worker = new Worker(new URL('./display-worker.mjs', import.meta.url), {type: 'module'});
        worker.onmessage = event => this.receive(event.data);
        worker.onerror = event => {
          if (this.worker !== worker) return;
          event.preventDefault(); const failed = this.active; this.stopWorker(); this.active = null;
          this.finish(failed, null, new Error('Display refinement failed.')); void this.pump();
        };
      }
      this.worker.postMessage({id: job.id, bitmap, width: job.width, height: job.height, sharpness: job.sharpness,
        density: job.density, cleanup: job.cleanup, stroke: job.stroke}, [bitmap]);
    } catch (error) {
      bitmap?.close();
      if (this.active === job) this.active = null;
      this.finish(job, null, error); void this.pump();
    }
  }
  receive(result) {
    const job = this.active;
    if (!job || job.id !== result.id) { result.bitmap?.close(); return; }
    this.active = null;
    try {
      if (result.error) throw new Error(result.error);
      if (job.signal?.aborted || !job.isCurrent()) throw abortError();
      const canvas = document.createElement('canvas'); canvas.width = job.width; canvas.height = job.height;
      const context = canvas.getContext('2d', {alpha: false}); context.imageSmoothingEnabled = false;
      context.drawImage(result.bitmap, 0, 0);
      this.finish(job, {canvas, method: result.method, elapsed: result.elapsed, density: job.density, cleanup: job.cleanup,
        stroke: job.stroke, strokeApplied: !!result.strokeApplied, crop: job.crop});
    } catch (error) { this.finish(job, null, error); }
    finally { result.bitmap?.close(); void this.pump(); }
  }
  clear() {
    this.stopWorker(); const jobs = [...this.queue, this.active].filter(Boolean); this.queue = []; this.active = null;
    for (const job of jobs) this.finish(job, null, abortError());
  }
  destroy() { this.disposed = true; this.clear(); }
}
