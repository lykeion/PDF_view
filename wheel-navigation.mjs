// A wheel burst may scroll within a spread OR leave the boundary where it
// began. Reaching an edge during that burst never authorizes a page turn.
// No timers or DOM state: the caller supplies monotonic event time and the
// scroll position before the browser applies that event's default scroll.
export const WHEEL_IDLE_MS = 350;

export class WheelPageNavigator {
  constructor({idleMs = WHEEL_IDLE_MS, threshold = 12, edgeTolerance = 1} = {}) {
    this.idleMs = idleMs;
    this.threshold = threshold;
    this.edgeTolerance = edgeTolerance;
    this.reset();
  }

  // reset() starts a new navigation context. reset(time) instead swallows the
  // remainder of an ongoing burst after an external change. Do not reset when
  // rendering a spread reached through consume(): its inertia must stay locked.
  reset(time) {
    this.lastTime = Number.isFinite(time) ? time : null;
    this.direction = 0;
    this.distance = 0;
    this.locked = true;
    this.blockTail = this.lastTime !== null;
    this.blocksScroll = false;
  }

  // Returns -1 (previous spread), +1 (next spread), or 0. Zero can mean normal
  // in-page scrolling, a boundary stop, or ignored input. The caller lets the
  // browser scroll inside the page and prevents default at the outward edge.
  // After consume(), blocksScroll also tells the caller to prevent the latest
  // vertical event's default scroll: it belongs to a turn/loading tail and must
  // not scroll through the new spread. Ignored modifiers/horizontal events keep
  // blocksScroll false so their original action remains available.
  consume({time, deltaY = 0, deltaX = 0, deltaMode = 0, top = 0, maxScroll = 0,
    canNext = false, canPrevious = false, busy = false, ctrlKey = false,
    metaKey = false, shiftKey = false} = {}) {
    this.blocksScroll = false;
    if (![time, deltaY, deltaX, top, maxScroll].every(Number.isFinite) || (!deltaY && !deltaX)) return 0;

    const fresh = this.lastTime === null || time - this.lastTime >= this.idleMs || time < this.lastTime;
    this.lastTime = time;
    const vertical = !ctrlKey && !metaKey && !shiftKey && deltaY !== 0 && Math.abs(deltaY) > Math.abs(deltaX);
    const direction = Math.sign(deltaY);
    const maximum = Math.max(0, maxScroll), position = Math.max(0, Math.min(maximum, top));
    const atEdge = direction > 0 ? maximum - position <= this.edgeTolerance : position <= this.edgeTolerance;
    const available = direction > 0 ? canNext : canPrevious;

    if (fresh) {
      this.direction = direction;
      this.distance = 0;
      this.locked = !vertical || busy || !atEdge || !available;
      this.blockTail = false;
    }
    if (busy) { this.locked = true; this.blockTail = true; }
    this.blocksScroll = vertical && this.blockTail;
    if (this.locked) return 0;
    // Direction changes, horizontal gestures, zoom gestures, and loading all
    // consume the burst instead of turning its remaining tail into navigation.
    if (!vertical || busy || direction !== this.direction || !atEdge || !available) {
      this.locked = true;
      return 0;
    }

    const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? 800 : 1;
    this.distance += Math.abs(deltaY) * unit;
    if (this.distance < this.threshold) return 0;
    this.locked = true;
    this.blockTail = true;
    this.blocksScroll = true;
    return direction;
  }
}
