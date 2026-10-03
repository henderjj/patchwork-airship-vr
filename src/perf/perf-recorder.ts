/**
 * Frame statistics with no rendering or IWSDK dependencies: a ring buffer of
 * recent frames for the HUD, plus one CSV row per second for playtest logs.
 * Nothing here allocates per frame.
 */

export const CSV_HEADER =
  'seconds,hz,fps,frame_ms_avg,frame_ms_p95,frame_ms_max,dropped,cpu_ms_avg,cpu_ms_p95,draw_calls,triangles,heap_mb,rtt_ms,label';

export interface FrameSample {
  /** Time between this frame and the previous one, ms. */
  intervalMs: number;
  /** Main-thread time from the first system to the end of renderer.render, ms. */
  cpuMs: number;
  drawCalls: number;
  triangles: number;
}

export class RingBuffer {
  readonly values: Float32Array;
  private next = 0;
  count = 0;

  constructor(readonly capacity: number) {
    this.values = new Float32Array(capacity);
  }

  push(value: number): void {
    this.values[this.next] = value;
    this.next = (this.next + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  /** Value i frames ago (0 = newest). */
  at(i: number): number {
    return this.values[(this.next - 1 - i + this.capacity * 2) % this.capacity];
  }

  clear(): void {
    this.next = 0;
    this.count = 0;
  }
}

/** Percentile of the first `count` values of `scratch` (sorted in place). */
export function percentile(scratch: Float32Array, count: number, p: number): number {
  if (count === 0) {
    return 0;
  }
  const view = scratch.subarray(0, count);
  view.sort();
  const index = Math.min(count - 1, Math.max(0, Math.ceil((p / 100) * count) - 1));
  return view[index];
}

export interface SecondSummary {
  seconds: number;
  hz: number;
  fps: number;
  frameAvg: number;
  frameP95: number;
  frameMax: number;
  dropped: number;
  cpuAvg: number;
  cpuP95: number;
  drawCalls: number;
  triangles: number;
  heapMb: number;
  rttMs: number;
}

export class PerfRecorder {
  /** Last few seconds of frame intervals and CPU times, for the HUD graph. */
  readonly intervals = new RingBuffer(270);
  readonly cpu = new RingBuffer(270);
  readonly rows: string[] = [CSV_HEADER];
  latest: SecondSummary = {
    seconds: 0, hz: 0, fps: 0, frameAvg: 0, frameP95: 0, frameMax: 0, dropped: 0,
    cpuAvg: 0, cpuP95: 0, drawCalls: 0, triangles: 0, heapMb: 0, rttMs: Number.NaN,
  };
  label = '';
  /** Network round trip, set by the network layer. NaN when not connected. */
  rttMs = Number.NaN;

  private secondIntervals = new Float32Array(512);
  private secondCpu = new Float32Array(512);
  private secondCount = 0;
  private secondStart = -1;
  private lastDrawCalls = 0;
  private lastTriangles = 0;
  private maxRows: number;

  constructor(maxRows = 60 * 60 * 2) {
    this.maxRows = maxRows;
  }

  /**
   * Record one frame. `nowMs` is the frame start time, `targetHz` the refresh
   * rate in use (for counting dropped frames), and `heapMb` may be NaN.
   */
  record(nowMs: number, sample: FrameSample, targetHz: number, heapMb: number): SecondSummary | null {
    this.intervals.push(sample.intervalMs);
    this.cpu.push(sample.cpuMs);
    this.lastDrawCalls = sample.drawCalls;
    this.lastTriangles = sample.triangles;
    if (this.secondStart < 0) {
      this.secondStart = nowMs;
    }
    if (this.secondCount < this.secondIntervals.length) {
      this.secondIntervals[this.secondCount] = sample.intervalMs;
      this.secondCpu[this.secondCount] = sample.cpuMs;
      this.secondCount++;
    }
    if (nowMs - this.secondStart < 1000) {
      return null;
    }
    return this.closeSecond(nowMs, targetHz, heapMb);
  }

  private closeSecond(nowMs: number, targetHz: number, heapMb: number): SecondSummary {
    const n = this.secondCount;
    let sum = 0;
    let max = 0;
    let dropped = 0;
    let cpuSum = 0;
    const budget = targetHz > 0 ? 1000 / targetHz : 1000 / 90;
    for (let i = 0; i < n; i++) {
      const v = this.secondIntervals[i];
      sum += v;
      max = Math.max(max, v);
      // A frame that took more than 1.5 refresh intervals missed a vsync.
      if (v > budget * 1.5) {
        dropped += Math.round(v / budget) - 1;
      }
      cpuSum += this.secondCpu[i];
    }
    const elapsed = nowMs - this.secondStart;
    const s = this.latest;
    s.seconds = this.rows.length;
    s.hz = targetHz;
    s.fps = (n * 1000) / elapsed;
    s.frameAvg = n ? sum / n : 0;
    s.frameMax = max;
    s.frameP95 = percentile(this.secondIntervals, n, 95);
    s.dropped = dropped;
    s.cpuAvg = n ? cpuSum / n : 0;
    s.cpuP95 = percentile(this.secondCpu, n, 95);
    s.drawCalls = this.lastDrawCalls;
    s.triangles = this.lastTriangles;
    s.heapMb = heapMb;
    s.rttMs = this.rttMs;
    if (this.rows.length < this.maxRows) {
      this.rows.push(
        [
          s.seconds, s.hz, s.fps.toFixed(1), s.frameAvg.toFixed(2), s.frameP95.toFixed(2),
          s.frameMax.toFixed(2), s.dropped, s.cpuAvg.toFixed(2), s.cpuP95.toFixed(2),
          s.drawCalls, s.triangles, Number.isNaN(heapMb) ? '' : heapMb.toFixed(1),
          Number.isNaN(s.rttMs) ? '' : s.rttMs.toFixed(1), this.label,
        ].join(','),
      );
    }
    this.secondCount = 0;
    this.secondStart = nowMs;
    return s;
  }

  csv(): string {
    return this.rows.join('\n') + '\n';
  }

  reset(): void {
    this.rows.length = 1;
    this.secondCount = 0;
    this.secondStart = -1;
    this.intervals.clear();
    this.cpu.clear();
  }
}
