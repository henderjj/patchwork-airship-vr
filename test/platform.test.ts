import { describe, expect, it } from 'vitest';
import { describeBrowser, type PlatformReport, summarize } from '../src/perf/platform-report.js';
import { estimateRefreshHz } from '../src/perf/refresh-rate.js';

const QUEST =
  'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/41.2.0.7.31 SamsungBrowser/4.0 Chrome/138.0.7204.183 VR Safari/537.36';
const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const EDGE_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.57';

function intervals(ms: number, count: number, jitter: number, seed = 1): Float32Array {
  const out = new Float32Array(count);
  let s = seed;
  for (let i = 0; i < count; i++) {
    s = (s * 16807) % 2147483647;
    out[i] = ms + ((s / 2147483647) * 2 - 1) * jitter;
  }
  return out;
}

describe('describeBrowser', () => {
  it('recognises the Quest Browser even though its user agent says Linux and Chrome', () => {
    expect(describeBrowser(QUEST)).toEqual({ kind: 'quest', browser: 'Quest Browser 41.2', os: 'Linux' });
  });

  it('recognises Chrome and Edge on Windows as PC', () => {
    expect(describeBrowser(CHROME_WIN)).toEqual({ kind: 'pc', browser: 'Chrome 141', os: 'Windows' });
    expect(describeBrowser(EDGE_WIN)).toEqual({ kind: 'pc', browser: 'Edge 141', os: 'Windows' });
  });
});

describe('summarize', () => {
  it('flags a measured rate, missing multiview and hand tracking', () => {
    const report = {
      ...describeBrowser(EDGE_WIN),
      hz: 90,
      hzSource: 'measured',
      multiview: false,
      inputs: ['left hand generic-hand', 'right hand generic-hand'],
    } as PlatformReport;
    expect(summarize(report)).toBe('PC Edge 141, ~90 Hz, no multiview, hands');
  });

  it('keeps a Quest with controllers short', () => {
    const report = {
      ...describeBrowser(QUEST),
      hz: 90,
      hzSource: 'reported',
      multiview: true,
      inputs: ['left controller meta-quest-touch-plus'],
    } as PlatformReport;
    expect(summarize(report)).toBe('Quest Browser 41.2, 90 Hz');
  });
});

describe('estimateRefreshHz', () => {
  it('waits for enough frames', () => {
    expect(estimateRefreshHz(intervals(11.1, 10, 0), 10)).toBeNull();
  });

  it('snaps jittery frame times to the headset rate', () => {
    expect(estimateRefreshHz(intervals(1000 / 90, 90, 1.5), 90)).toBe(90);
    expect(estimateRefreshHz(intervals(1000 / 72, 90, 1.5), 90)).toBe(72);
    expect(estimateRefreshHz(intervals(1000 / 120, 90, 0.8), 90)).toBe(120);
    expect(estimateRefreshHz(intervals(1000 / 80, 90, 1.2), 90)).toBe(80);
  });

  it('ignores a few dropped frames', () => {
    const frames = intervals(1000 / 90, 90, 1);
    for (let i = 0; i < 20; i++) {
      frames[i * 4] = 22.2;
    }
    expect(estimateRefreshHz(frames, 90)).toBe(90);
  });

  it('reports the halved rate under SpaceWarp', () => {
    expect(estimateRefreshHz(intervals(1000 / 45, 90, 1), 90)).toBe(45);
  });
});
