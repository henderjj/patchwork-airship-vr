import { describe, expect, it } from 'vitest';
import { stereoOpus } from '../src/net/voice.js';

const SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  '',
].join('\r\n');

describe('stereoOpus', () => {
  it('asks for stereo on the Opus format line only', () => {
    const out = stereoOpus(SDP);
    expect(out).toContain('a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000\r\n');
    expect(out).toContain('a=fmtp:63 111/111\r\n');
  });

  it('is idempotent and leaves SDP without Opus alone', () => {
    expect(stereoOpus(stereoOpus(SDP))).toBe(stereoOpus(SDP));
    expect(stereoOpus('v=0\r\n')).toBe('v=0\r\n');
  });
});
