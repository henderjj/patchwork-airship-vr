import { describe, expect, it } from 'vitest';
import { codeShown, crewScreen, menuCrewLine, typeCode } from '../src/game-flow.js';

describe('start screen', () => {
  it('types a four-letter crew code', () => {
    let typed = '';
    for (const key of ['A', 'B', 'del', 'C', 'D', 'E', 'F']) {
      typed = typeCode(typed, key);
    }
    expect(typed).toBe('ACDE');
    expect(codeShown('AC')).toBe('A C _ _');
    expect(typeCode('', 'del')).toBe('');
    expect(typeCode('A', '1')).toBe('A');
  });

  it('says how to bring in the practice crewmate', () => {
    const s = crewScreen('practice', 'waiting', 'QRST', '', '', 'example.com/game');
    expect(s.status).toBe('Waiting for the practice crewmate.');
    expect(s.help).toContain('example.com/game/?room=QRST&bot=1');
    expect(s.ready).toBe(false);
  });

  it('tells a host to share the code, and starts once the crewmate is aboard', () => {
    expect(crewScreen('host', 'waiting', 'QRST', '', '', 'x').help).toContain('QRST');
    const aboard = crewScreen('host', 'connected', 'QRST', '', 'Ann', 'x');
    expect(aboard.status).toBe('Ann is aboard.');
    expect(aboard.ready).toBe(true);
  });

  it('explains a full crew or a failed join', () => {
    expect(crewScreen('join', 'full', 'QRST', '', '', 'x').status).toContain('already has two players');
    expect(crewScreen('join', 'error', 'QRST', 'lobby unreachable', '', 'x').status).toContain('lobby unreachable');
  });
});

describe('game menu', () => {
  it('says nothing about a crew when playing solo', () => {
    expect(menuCrewLine('idle', '', '', false)).toBe('');
    expect(menuCrewLine('closed', 'QRST', '', false)).toBe('');
  });

  it('names the crew and the crewmate', () => {
    expect(menuCrewLine('connected', 'QRST', 'Ann', false)).toBe('Crew QRST: playing with Ann.');
    expect(menuCrewLine('waiting', 'QRST', '', true)).toBe('Crew QRST: waiting for the practice crewmate.');
  });
});
