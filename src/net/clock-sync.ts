/**
 * NTP-style clock sync between the two players. Each ping records the local
 * send time t0; the peer replies with t0 and its own receive time t1; on the
 * pong at local time t2, RTT = t2 − t0 and the peer's clock is ahead of ours
 * by t1 − (t0 + RTT/2). The sample with the lowest RTT in the recent window
 * is the most trustworthy (least queueing), so the offset comes from it.
 * Pure TypeScript.
 */

const WINDOW = 16;

export interface NetStats {
  /** Latest round trip, ms. */
  rtt: number;
  /** Smoothed round trip, ms. */
  srtt: number;
  /** Mean absolute deviation of RTT, ms (jitter). */
  jitter: number;
  /** Peer clock minus local clock, ms. */
  offset: number;
  samples: number;
}

export class ClockSync {
  readonly stats: NetStats = { rtt: Number.NaN, srtt: Number.NaN, jitter: 0, offset: 0, samples: 0 };
  private rtts = new Float64Array(WINDOW);
  private offsets = new Float64Array(WINDOW);
  private next = 0;
  private count = 0;

  onPong(t0: number, t1: number, t2: number): void {
    const rtt = t2 - t0;
    if (!(rtt >= 0) || rtt > 10000) {
      return;
    }
    const offset = t1 - (t0 + rtt / 2);
    this.rtts[this.next] = rtt;
    this.offsets[this.next] = offset;
    this.next = (this.next + 1) % WINDOW;
    this.count = Math.min(this.count + 1, WINDOW);
    const s = this.stats;
    s.samples++;
    if (Number.isNaN(s.srtt)) {
      s.srtt = rtt;
    } else {
      s.jitter += (Math.abs(rtt - s.srtt) - s.jitter) / 8;
      s.srtt += (rtt - s.srtt) / 8;
    }
    s.rtt = rtt;
    let best = 0;
    for (let i = 1; i < this.count; i++) {
      if (this.rtts[i] < this.rtts[best]) {
        best = i;
      }
    }
    s.offset = this.offsets[best];
  }

  /** Convert a peer timestamp to local time. */
  toLocal(peerTimeMs: number): number {
    return peerTimeMs - this.stats.offset;
  }
}
