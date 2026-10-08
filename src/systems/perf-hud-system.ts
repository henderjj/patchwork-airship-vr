import {
  CanvasTexture,
  createSystem,
  InputComponent,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  VisibilityState,
} from '@iwsdk/core';
import { PerfRecorder } from '../perf/perf-recorder.js';
import { settings } from '../settings.js';
import { estimateRefreshHz } from '../perf/refresh-rate.js';
import { platformInfo, summarize } from '../perf/platform-report.js';
import { budgetHz, frameRateInfo } from './frame-rate-system.js';
import { grip, handGrips } from './grip-system.js';

/** Shared recorder: the network layer writes `rttMs`, tests read `csv()`. */
export const perf = new PerfRecorder();

const CANVAS_W = 512;
const CANVAS_H = 356;
const HUD_REFRESH_MS = 250;
/** Recent frames used to measure the refresh rate when the runtime doesn't report it. */
const MEASURE_FRAMES = 90;

interface PerfWindow {
  __perf?: {
    recorder: PerfRecorder;
    csv: () => string;
    download: () => void;
    setLabel: (label: string) => void;
  };
}

/**
 * In-headset performance HUD on the left wrist (toggle with the X button, or
 * H on a keyboard), plus a per-second CSV log. Shows frame time against the
 * refresh budget, main-thread time, draw calls, triangles, heap and network
 * round trip.
 *
 * Register this system with a very low priority so it runs first in the
 * frame; it wraps renderer.render to time the rest of the frame.
 */
export class PerfHudSystem extends createSystem({}) {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private texture!: CanvasTexture;
  private panel!: Mesh;
  private overlay: HTMLDivElement | null = null;
  private overlayText: HTMLSpanElement | null = null;
  private frameStart = 0;
  private lastFrameStart = 0;
  private renderEnd = 0;
  private lastHudDraw = 0;
  private lastLog = 0;
  private visible = settings.hud;
  private sample = { intervalMs: 0, cpuMs: 0, drawCalls: 0, triangles: 0 };
  private measureScratch = new Float32Array(MEASURE_FRAMES);
  private immersiveFrames = 0;

  init(): void {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.panel = new Mesh(
      new PlaneGeometry(0.16, (0.16 * CANVAS_H) / CANVAS_W),
      new MeshBasicMaterial({ map: this.texture, toneMapped: false }),
    );
    this.panel.name = 'PerfHud';
    // Above the left fist, clear of the glove's cuff and sleeve (which
    // leave the fist up and back along the grip's +Y and +Z), tilted
    // towards the eyes.
    this.panel.position.set(-0.04, 0.16, 0.06);
    this.panel.rotation.set(-1.2, 0, 0);
    this.world.createTransformEntity(this.panel, {
      parent: this.world.playerSpaceEntities.gripSpaces.left,
      persistent: true,
    });

    const renderer = this.renderer;
    const render = renderer.render.bind(renderer);
    renderer.render = (scene, camera) => {
      render(scene, camera);
      this.renderEnd = performance.now();
    };

    this.overlay = document.createElement('div');
    this.overlay.style.cssText =
      'position:fixed;right:8px;bottom:8px;z-index:10;font:12px/1.3 monospace;background:rgba(10,14,20,.8);color:#e8eef5;padding:6px 8px;border-radius:6px;white-space:pre;pointer-events:auto';
    this.overlayText = document.createElement('span');
    const link = document.createElement('a');
    link.textContent = 'CSV';
    link.href = '#';
    link.style.color = '#93c5fd';
    link.onclick = (event) => {
      event.preventDefault();
      downloadCsv(perf.csv());
    };
    this.overlay.append(this.overlayText, link);
    document.body.appendChild(this.overlay);
    this.cleanupFuncs.push(() => this.overlay?.remove());

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'h' || event.key === 'H') {
        this.visible = !this.visible;
      }
    };
    window.addEventListener('keydown', onKey);
    this.cleanupFuncs.push(() => window.removeEventListener('keydown', onKey));

    perf.label = settings.label.replace(/[,\n]/g, ' ');
    (window as PerfWindow).__perf = {
      recorder: perf,
      csv: () => perf.csv(),
      download: () => downloadCsv(perf.csv()),
      setLabel: (label: string) => {
        perf.label = label.replace(/[,\n]/g, ' ');
      },
    };
  }

  update(): void {
    const now = performance.now();
    if (this.lastFrameStart > 0) {
      const info = this.renderer.info.render;
      this.sample.intervalMs = now - this.lastFrameStart;
      this.sample.cpuMs = Math.max(0, this.renderEnd - this.frameStart);
      this.sample.drawCalls = info.calls;
      this.sample.triangles = info.triangles;
      const hz = budgetHz(!!this.world.session);
      const summary = perf.record(now, this.sample, hz, heapMb());
      if (summary && this.world.session && frameRateInfo.actual === null) {
        this.measureRefresh();
      }
      if (summary && now - this.lastLog > 10000) {
        this.lastLog = now;
        console.info(
          `[Perf] ${summary.fps.toFixed(1)} fps @${hz}Hz frame avg ${summary.frameAvg.toFixed(2)} p95 ${summary.frameP95.toFixed(2)} ms, cpu ${summary.cpuAvg.toFixed(2)} ms, ${summary.drawCalls} calls, ${summary.triangles} tris, dropped ${summary.dropped}`,
        );
      }
    }
    this.lastFrameStart = now;
    this.frameStart = now;

    if (this.world.session) {
      this.immersiveFrames++;
      frameRateInfo.actual = this.world.session.frameRate ?? frameRateInfo.actual;
      if (this.input.xr.gamepads.left?.getButtonDown(InputComponent.X_Button)) {
        this.visible = !this.visible;
      }
    } else {
      this.immersiveFrames = 0;
    }

    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    this.panel.visible = this.visible && immersive;
    if (this.overlay) {
      this.overlay.style.display = this.visible && !immersive ? 'block' : 'none';
    }
    if (this.visible && now - this.lastHudDraw > HUD_REFRESH_MS) {
      this.lastHudDraw = now;
      if (immersive) {
        this.drawCanvas();
      } else {
        this.drawOverlay();
      }
    }
  }

  /** Once a second while immersive: the refresh rate from the last frames in the session. */
  private measureRefresh(): void {
    const count = Math.min(MEASURE_FRAMES, this.immersiveFrames, perf.intervals.count);
    for (let i = 0; i < count; i++) {
      this.measureScratch[i] = perf.intervals.at(i);
    }
    frameRateInfo.measured = estimateRefreshHz(this.measureScratch, count) ?? frameRateInfo.measured;
  }

  private drawCanvas(): void {
    const ctx = this.ctx;
    const s = perf.latest;
    const hz = budgetHz(true);
    const budget = 1000 / hz;
    ctx.fillStyle = '#0d1219';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Frame-time graph: one bar per frame, newest on the right.
    const graphTop = 8;
    const graphH = 120;
    const maxMs = budget * 2.5;
    const n = perf.intervals.count;
    const barW = CANVAS_W / perf.intervals.capacity;
    for (let i = 0; i < n; i++) {
      const v = perf.intervals.at(i);
      const h = Math.min(graphH, (v / maxMs) * graphH);
      ctx.fillStyle = v > budget * 1.5 ? '#ef4444' : v > budget * 1.1 ? '#f59e0b' : '#22c55e';
      ctx.fillRect(CANVAS_W - (i + 1) * barW, graphTop + graphH - h, Math.max(1, barW), h);
      const c = perf.cpu.at(i);
      const ch = Math.min(graphH, (c / maxMs) * graphH);
      ctx.fillStyle = '#60a5fa';
      ctx.fillRect(CANVAS_W - (i + 1) * barW, graphTop + graphH - ch, Math.max(1, barW), 2);
    }
    const budgetY = graphTop + graphH - (budget / maxMs) * graphH;
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(0, budgetY, CANVAS_W, 1);

    ctx.font = 'bold 26px monospace';
    ctx.fillStyle = s.fps >= hz * 0.97 ? '#4ade80' : '#f87171';
    const measured = frameRateInfo.actual === null && frameRateInfo.measured !== null ? '~' : '';
    ctx.fillText(`${s.fps.toFixed(1)} fps / ${measured}${hz} Hz`, 10, graphTop + graphH + 32);
    ctx.font = '20px monospace';
    ctx.fillStyle = '#e8eef5';
    ctx.fillText(
      `frame ${s.frameAvg.toFixed(1)} p95 ${s.frameP95.toFixed(1)} max ${s.frameMax.toFixed(1)} ms`,
      10,
      graphTop + graphH + 60,
    );
    ctx.fillText(`cpu ${s.cpuAvg.toFixed(2)} p95 ${s.cpuP95.toFixed(2)} ms  drop ${s.dropped}`, 10, graphTop + graphH + 86);
    ctx.fillText(
      `calls ${s.drawCalls}  tris ${(s.triangles / 1000).toFixed(0)}k  heap ${Number.isNaN(s.heapMb) ? '-' : s.heapMb.toFixed(0)}MB`,
      10,
      graphTop + graphH + 112,
    );
    ctx.fillText(
      `rtt ${Number.isNaN(s.rttMs) ? '-' : s.rttMs.toFixed(0) + ' ms'}  ${perf.label}`,
      10,
      graphTop + graphH + 138,
    );
    ctx.font = '17px monospace';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(`me   ${platformInfo.mine ? summarize(platformInfo.mine) : '-'}`, 10, graphTop + graphH + 164);
    ctx.fillText(`crew ${platformInfo.crew ? summarize(platformInfo.crew) : '-'}`, 10, graphTop + graphH + 188);
    if (grip.left.hand || grip.right.hand) {
      // Hand tracking (spike S9): how curled each hand is (1 open, under 0.6 a fist) and the pinch gap.
      const l = handGrips.left, r = handGrips.right;
      ctx.fillText(
        `hands L ${l.curl.toFixed(2)} ${(l.pinchDistance * 100).toFixed(0)}cm${grip.left.pressed ? '*' : ''}  R ${r.curl.toFixed(2)} ${(r.pinchDistance * 100).toFixed(0)}cm${grip.right.pressed ? '*' : ''}`,
        10,
        graphTop + graphH + 212,
      );
    }
    this.texture.needsUpdate = true;
  }

  private drawOverlay(): void {
    if (!this.overlayText) {
      return;
    }
    const s = perf.latest;
    this.overlayText.textContent =
      `${s.fps.toFixed(1)} fps  frame ${s.frameAvg.toFixed(1)}/${s.frameP95.toFixed(1)} ms\n` +
      `cpu ${s.cpuAvg.toFixed(2)} ms  calls ${s.drawCalls}  tris ${(s.triangles / 1000).toFixed(0)}k\n` +
      `rtt ${Number.isNaN(s.rttMs) ? '-' : s.rttMs.toFixed(0) + ' ms'}  [H] hide  `;
  }
}

function heapMb(): number {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize / 1048576 : Number.NaN;
}

function downloadCsv(text: string): void {
  const blob = new Blob([text], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `patchwork-perf-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
