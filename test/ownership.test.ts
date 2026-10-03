import { describe, expect, it } from 'vitest';
import { ObjectBuffer } from '../src/net/object-buffer.js';
import { Accept, Change, epochNewer, GUEST, HOST, Ownership, type OwnershipEvent } from '../src/net/ownership.js';
import { createPoseSample, decodeObject, encodeObject, OBJECT_PACKET_BYTES } from '../src/net/pose-codec.js';

/** A host and a guest table wired back to back; events are delivered by flush(). */
function pair(count = 2) {
  const toGuest: OwnershipEvent[] = [];
  const toHost: OwnershipEvent[] = [];
  const host = new Ownership(count, (e) => toGuest.push(e));
  const guest = new Ownership(count, (e) => toHost.push(e));
  host.reset(HOST);
  guest.reset(GUEST);
  const changes = { host: [] as Change[], guest: [] as Change[] };
  const flush = (hostHolds = false) => {
    while (toGuest.length || toHost.length) {
      for (const e of toHost.splice(0)) {
        if (e.t === 'claim') changes.host.push(host.onClaim(e.id, e.epoch, hostHolds));
      }
      for (const e of toGuest.splice(0)) {
        if (e.t === 'own') changes.guest.push(guest.onOwn(e.id, e.owner, e.epoch));
      }
    }
  };
  return { host, guest, toGuest, toHost, flush, changes };
}

describe('ownership', () => {
  it('starts with the host owning everything', () => {
    const { host, guest } = pair();
    expect(host.owns(0)).toBe(true);
    expect(guest.owns(0)).toBe(false);
  });

  it('grants a guest catch and both agree on the new owner and epoch', () => {
    const { host, guest, flush, changes } = pair();
    expect(guest.grab(0)).toBe(true);
    expect(guest.owns(0)).toBe(true); // at once, before the host answers
    flush();
    expect(changes.host).toEqual([Change.Lost]);
    expect(changes.guest).toEqual([Change.None]);
    expect(host.objects[0]).toMatchObject({ owner: GUEST, epoch: 1 });
    expect(guest.objects[0]).toMatchObject({ owner: GUEST, epoch: 1, pending: false });
  });

  it('accepts the guest packets sent under the predicted epoch once granted', () => {
    const { host, guest, flush } = pair();
    guest.grab(0);
    const epoch = guest.objects[0].epoch;
    expect(host.acceptState(0, epoch, true)).toBe(Accept.Drop); // claim not here yet
    flush();
    expect(host.acceptState(0, epoch, true)).toBe(Accept.Use);
    expect(host.objects[0].remoteHeld).toBe(true);
    expect(host.acceptState(0, 0, false)).toBe(Accept.Drop); // sent before the hand-over
  });

  it('refuses a guest claim when the host grabbed first, and the guest lets go', () => {
    const { host, guest, flush, changes } = pair();
    host.grab(0); // host epoch 1, announcement in flight
    guest.grab(0); // guest claims under predicted epoch 1
    flush();
    expect(host.objects[0]).toMatchObject({ owner: HOST, epoch: 1 });
    expect(guest.objects[0]).toMatchObject({ owner: HOST, epoch: 1, pending: false });
    expect(changes.guest).toContain(Change.Lost);
    expect(guest.refused).toBe(1);
  });

  it('refuses a claim on an object a host hand holds', () => {
    const { host, guest, flush } = pair();
    guest.grab(0);
    flush(true);
    expect(host.owns(0)).toBe(true);
    expect(guest.owns(0)).toBe(false);
  });

  it('lets the host take back an object the guest threw', () => {
    const { host, guest, flush, changes } = pair();
    guest.grab(0);
    flush();
    expect(host.acceptState(0, 1, false)).toBe(Accept.Use); // thrown, no longer held
    expect(host.grab(0)).toBe(true);
    expect(host.objects[0]).toMatchObject({ owner: HOST, epoch: 2 });
    flush();
    expect(changes.guest.at(-1)).toBe(Change.Lost);
    expect(guest.objects[0]).toMatchObject({ owner: HOST, epoch: 2 });
  });

  it('treats a host packet under a newer epoch as the host taking the object', () => {
    const { host, guest, flush } = pair();
    guest.grab(0);
    flush();
    host.acceptState(0, 1, false);
    host.grab(0); // announcement still in flight
    expect(guest.acceptState(0, 2, true)).toBe(Accept.UseAndLost);
    expect(guest.owns(0)).toBe(false);
    flush();
    expect(guest.objects[0]).toMatchObject({ owner: HOST, epoch: 2 });
  });

  it('will not take an object the crewmate is holding', () => {
    const { host, guest, flush } = pair();
    guest.grab(0);
    flush();
    host.acceptState(0, 1, true);
    expect(host.grab(0)).toBe(false);
    expect(host.objects[0].owner).toBe(GUEST);
  });

  it('compares epochs across the wrap', () => {
    expect(epochNewer(1, 0)).toBe(true);
    expect(epochNewer(0, 255)).toBe(true);
    expect(epochNewer(255, 0)).toBe(false);
    expect(epochNewer(5, 5)).toBe(false);
  });
});

describe('object packets and buffer', () => {
  it('round-trips an object state', () => {
    const buffer = new ArrayBuffer(OBJECT_PACKET_BYTES);
    const pose = { px: 1.234, py: -0.5, pz: 2, qx: 0, qy: Math.SQRT1_2, qz: 0, qw: Math.SQRT1_2 };
    const length = encodeObject(buffer, { id: 7, epoch: 200, flags: 1, timeMs: 123456.7, pose });
    expect(length).toBe(OBJECT_PACKET_BYTES);
    const out = { id: 0, epoch: 0, flags: 0, timeMs: 0, pose: createPoseSample() };
    expect(decodeObject(new DataView(buffer), out)).toBe(true);
    expect(out).toMatchObject({ id: 7, epoch: 200, flags: 1, timeMs: 123456 });
    expect(out.pose.px).toBeCloseTo(1.234, 3);
    expect(out.pose.qy).toBeCloseTo(Math.SQRT1_2, 4);
  });

  it('interpolates, holds before the first pose and extrapolates briefly', () => {
    const b = new ObjectBuffer();
    const p = createPoseSample();
    const out = createPoseSample();
    expect(b.sample(0, out)).toBe(-1);
    for (let i = 0; i < 5; i++) {
      p.px = i * 0.1; // 0.1 m per 20 ms = 5 m/s
      b.push(1000 + i * 20, p, i === 0 ? 1 : 0);
    }
    expect(b.sample(990, out)).toBe(1);
    expect(out.px).toBe(0);
    b.sample(1030, out);
    expect(out.px).toBeCloseTo(0.15, 6);
    b.sample(1080 + 20, out);
    expect(out.px).toBeCloseTo(0.5, 6);
    b.sample(1080 + 500, out); // capped at 50 ms ahead
    expect(out.px).toBeCloseTo(0.65, 6);
  });

  it('extrapolates a thrown object along its parabola despite uneven frame times', () => {
    const b = new ObjectBuffer();
    const p = createPoseSample();
    const out = createPoseSample();
    const g = [0, -9.81, 0];
    const v = [0, 2.5, -5];
    const at = (t: number) => [v[0] * t, 1.2 + v[1] * t - 4.905 * t * t, v[2] * t];
    // Frames 22 ms apart on average but stamped up to ±8 ms off.
    const jitter = [0, 7, -6, 8, -8, 3, -5];
    for (let i = 0; i < jitter.length; i++) {
      const t = (i * 22 + jitter[i]) / 1000;
      [p.px, p.py, p.pz] = at(t);
      b.push(1000 + t * 1000, p, 0);
    }
    const newest = 1000 + 6 * 22 - 5;
    b.sample(newest + 150, out, g, 200);
    const truth = at((newest + 150 - 1000) / 1000);
    expect(Math.hypot(out.px - truth[0], out.py - truth[1], out.pz - truth[2])).toBeLessThan(0.01);
  });
});
