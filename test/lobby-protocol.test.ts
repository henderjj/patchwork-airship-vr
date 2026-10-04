import { describe, expect, it } from 'vitest';
import { LobbyRoom, makeRoomCode, normaliseRoomCode, type ServerMessage } from '../src/net/lobby-protocol.js';

function harness() {
  const sent: [string, ServerMessage][] = [];
  const closed: string[] = [];
  const room = new LobbyRoom(
    { send: (id, m) => sent.push([id, m]), close: (id) => closed.push(id) },
    () => [{ urls: 'stun:example' }],
  );
  return { room, sent, closed };
}

const hello = (name: string) => JSON.stringify({ t: 'hello', name, color: 1 });

describe('lobby room', () => {
  it('first member hosts, second is told about the first and vice versa', async () => {
    const { room, sent } = harness();
    await room.onMessage('a', hello('Ann'));
    await room.onMessage('b', hello('Bo'));
    const welcomeB = sent.find(([id, m]) => id === 'b' && m.t === 'welcome')![1] as Extract<ServerMessage, { t: 'welcome' }>;
    expect(welcomeB.you.host).toBe(false);
    expect(welcomeB.crew.map((m) => m.id)).toEqual(['a']);
    expect(welcomeB.iceServers[0].urls).toBe('stun:example');
    expect(sent.some(([id, m]) => id === 'a' && m.t === 'joined' && m.member.id === 'b')).toBe(true);
  });

  it('turns away a third member', async () => {
    const { room, sent, closed } = harness();
    await room.onMessage('a', hello('Ann'));
    await room.onMessage('b', hello('Bo'));
    await room.onMessage('c', hello('Cy'));
    expect(sent.at(-1)).toEqual(['c', { t: 'full' }]);
    expect(closed).toEqual(['c']);
  });

  it('relays signals only between members', async () => {
    const { room, sent } = harness();
    await room.onMessage('a', hello('Ann'));
    await room.onMessage('b', hello('Bo'));
    const data = { kind: 'offer', sdp: 'x' };
    await room.onMessage('a', JSON.stringify({ t: 'signal', to: 'b', data }));
    await room.onMessage('z', JSON.stringify({ t: 'signal', to: 'b', data }));
    const signals = sent.filter(([, m]) => m.t === 'signal');
    expect(signals).toEqual([['b', { t: 'signal', from: 'a', data }]]);
  });

  it('accepts a keepalive ping without answering', async () => {
    const { room, sent } = harness();
    await room.onMessage('a', hello('Ann'));
    const before = sent.length;
    await room.onMessage('a', JSON.stringify({ t: 'ping' }));
    expect(sent.length).toBe(before);
  });

  it('passes the host role on when the host leaves', async () => {
    const { room, sent } = harness();
    await room.onMessage('a', hello('Ann'));
    await room.onMessage('b', hello('Bo'));
    room.onClose('a');
    expect(sent.at(-1)).toEqual(['b', { t: 'left', id: 'a', newHost: 'b' }]);
    expect(room.members.get('b')!.host).toBe(true);
  });

  it('lets a player whose connection died rejoin a full room', async () => {
    const { room, sent, closed } = harness();
    await room.onMessage('a', JSON.stringify({ t: 'hello', name: 'Ann', color: 1, player: 'ann-page' }));
    await room.onMessage('b', JSON.stringify({ t: 'hello', name: 'Bo', color: 2, player: 'bo-page' }));
    // Ann's network dropped; her old connection hasn't closed on the server yet.
    await room.onMessage('a2', JSON.stringify({ t: 'hello', name: 'Ann', color: 1, player: 'ann-page' }));
    expect(closed).toEqual(['a']);
    expect(sent).toContainEqual(['b', { t: 'left', id: 'a', newHost: 'b' }]);
    expect(sent.some(([id, m]) => id === 'b' && m.t === 'joined' && m.member.id === 'a2')).toBe(true);
    expect([...room.members.keys()]).toEqual(['b', 'a2']);
    // A different player still finds the room full.
    await room.onMessage('c', JSON.stringify({ t: 'hello', name: 'Cy', color: 3, player: 'cy-page' }));
    expect(sent.at(-1)).toEqual(['c', { t: 'full' }]);
  });

  it('makes and checks room codes', () => {
    const code = makeRoomCode();
    expect(normaliseRoomCode(code.toLowerCase())).toBe(code);
    expect(normaliseRoomCode('AB1D')).toBeNull();
    expect(code).not.toMatch(/[ILO]/);
  });
});
