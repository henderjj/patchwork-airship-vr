import { describe, expect, it } from 'vitest';
import { describeVrError, HUNG_START_MS, SLOW_START_MS, vrStartMessage, vrSupportNote } from '../src/vr-messages.js';

describe('vrStartMessage', () => {
  const starting = (grantedMs: number | null = null) => ({ phase: 'starting' as const, sinceMs: 1000, grantedMs });

  it('says nothing when idle or in VR', () => {
    expect(vrStartMessage({ phase: 'idle' }, 0, 'pc')).toBe('');
    expect(vrStartMessage({ phase: 'in-vr', tookMs: 2000 }, 0, 'pc')).toBe('');
  });

  it('explains a slow start through Link on a PC, counting the seconds', () => {
    expect(vrStartMessage(starting(), 1000 + 2000, 'quest')).toBe('Starting VR...');
    expect(vrStartMessage(starting(), 1000 + SLOW_START_MS + 12500, 'pc')).toBe(
      'Starting VR (20 s). Check the browser window on the PC screen: if it asks to use your virtual reality devices, click Allow. ' +
        'Through Link the start can also take about a minute.',
    );
    expect(vrStartMessage(starting(), 1000 + SLOW_START_MS + 12500, 'quest')).toBe('Starting VR (20 s)...');
  });

  it('says when the headset accepted but no picture has come yet', () => {
    expect(vrStartMessage(starting(50000), 1000 + 56000, 'pc')).toBe(
      'Starting VR (56 s): the headset accepted, waiting for the first picture...',
    );
  });

  it("points a PC player at the browser's VR permission prompt from the start", () => {
    expect(vrStartMessage(starting(), 1000 + 2000, 'pc')).toBe(
      'Starting VR... Check the browser window on the PC screen: if it asks to use your virtual reality devices, click Allow.',
    );
  });

  it('asks for the WebXR internals page when the start hangs on a PC', () => {
    const hung = vrStartMessage(starting(), 1000 + HUNG_START_MS, 'pc');
    expect(hung).toMatch(/^VR still hasn't started after 90 s\. Check the browser window on the PC screen/);
    expect(hung).toContain('Unknown Sources');
    expect(hung).toContain('chrome://webxr-internals (edge://webxr-internals in Edge)');
  });

  it('asks for a second press when VR stopped because the graphics moved to the headset GPU', () => {
    expect(vrStartMessage({ phase: 'ended-early', contextLost: true }, 0, 'pc')).toBe(
      'VR stopped while the browser moved its graphics to the graphics card the headset uses. Press Enter VR again; it should start this time.',
    );
    expect(vrStartMessage({ phase: 'ended-early', contextLost: false }, 0, 'pc')).toMatch(/^VR started but closed straight away/);
  });

  it('gives the reason for a failure, with the Link checks on a PC', () => {
    const failed = { phase: 'failed' as const, error: 'the browser found no VR headset' };
    expect(vrStartMessage(failed, 0, 'quest')).toBe("VR didn't start: the browser found no VR headset.");
    expect(vrStartMessage(failed, 0, 'pc')).toMatch(/^VR didn't start: the browser found no VR headset\. Check that the headset is connected through Link/);
  });
});

describe('vrSupportNote', () => {
  it('offers the button wherever the browser sees a headset', () => {
    expect(vrSupportNote('quest', true, true)).toEqual({ button: true, note: '' });
    expect(vrSupportNote('pc', true, true)).toEqual({ button: true, note: '' });
  });

  it('keeps the button on a PC that sees no headset yet, with a note', () => {
    expect(vrSupportNote('pc', true, false)).toEqual({
      button: true,
      note: 'The browser sees no VR headset yet. Start Link or Air Link, then press Enter VR.',
    });
  });

  it('names Chrome and Edge on a PC browser without WebXR, and stays quiet elsewhere', () => {
    expect(vrSupportNote('pc', false, false)).toEqual({ button: false, note: "This browser can't run VR. On a PC, use Chrome or Edge." });
    expect(vrSupportNote('other', false, false)).toEqual({ button: false, note: '' });
    expect(vrSupportNote('android', true, false)).toEqual({ button: false, note: '' });
  });
});

describe('describeVrError', () => {
  it('turns the usual WebXR errors into plain words', () => {
    expect(describeVrError(new DOMException('No headset in this test', 'NotSupportedError'))).toBe(
      'the browser found no VR headset (No headset in this test)',
    );
    expect(describeVrError(new DOMException('', 'SecurityError'))).toBe('the browser refused');
    expect(describeVrError(new Error('boom'))).toBe('Error: boom');
    expect(describeVrError('odd')).toBe('odd');
  });
});
