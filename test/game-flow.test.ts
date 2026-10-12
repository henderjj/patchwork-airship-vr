import { describe, expect, it } from 'vitest';
import { codeShown, crewScreen, heightShown, menuCrewLine, stepHeight, typeCode } from '../src/game-flow.js';

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

describe('character height in the game menu', () => {
  const step = (height: number, own: number, direction: 1 | -1) => stepHeight(height, own, direction, 1.4, 2.0, 1.75);

  it('steps 5 cm at a time and stays in range', () => {
    expect(step(1.75, Number.NaN, 1)).toBe(1.8);
    expect(step(1.75, Number.NaN, -1)).toBe(1.7);
    expect(step(2.0, Number.NaN, 1)).toBe(2.0);
    expect(step(1.4, Number.NaN, -1)).toBe(1.4);
  });

  it('steps from the player\'s own height to the next step either side', () => {
    expect(step(0, 1.78, 1)).toBe(1.8);
    expect(step(0, 1.78, -1)).toBe(1.75);
    expect(step(0, 1.8, 1)).toBe(1.85);
    expect(step(0, Number.NaN, 1)).toBe(1.8);
  });

  it('shows the height, or the player\'s own once measured', () => {
    expect(heightShown(1.85, 1.7)).toBe('1.85 m');
    expect(heightShown(0, 1.776)).toBe('1.78 m');
    expect(heightShown(0, Number.NaN)).toBe('-');
  });
});
