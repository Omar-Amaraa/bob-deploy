import { describe, it, expect } from 'vitest';
import { parseListeningPorts, findFreePortPair } from './ports.js';
import { fakeRemoteExec, execResult } from './testing/fake-remote-exec.js';

const SS_OUTPUT = `LISTEN 0      511          0.0.0.0:22           0.0.0.0:*
LISTEN 0      511          0.0.0.0:80           0.0.0.0:*
LISTEN 0      511          127.0.0.1:3100       0.0.0.0:*
LISTEN 0      511             [::]:443              [::]:*
`;

describe('parseListeningPorts', () => {
  it('extracts every locally-bound port regardless of address family', () => {
    expect(parseListeningPorts(SS_OUTPUT)).toEqual(new Set([22, 80, 3100, 443]));
  });

  it('returns an empty set for empty output', () => {
    expect(parseListeningPorts('')).toEqual(new Set());
  });
});

describe('findFreePortPair', () => {
  it('returns the first free pair >= 3100 when nothing is listening', async () => {
    const exec = fakeRemoteExec([], execResult({ stdout: '' }));
    const pair = await findFreePortPair(exec);
    expect(pair).toEqual({ portA: 3100, portB: 3101 });
  });

  it('skips ports already listening on the server', async () => {
    const exec = fakeRemoteExec([], execResult({ stdout: SS_OUTPUT }));
    const pair = await findFreePortPair(exec);
    // 3100 is taken; 3101/3102 is the next free pair.
    expect(pair).toEqual({ portA: 3101, portB: 3102 });
  });

  it('skips ports already reserved by other targets on this server', async () => {
    const exec = fakeRemoteExec([], execResult({ stdout: '' }));
    const pair = await findFreePortPair(exec, [3100, 3102]);
    // 3100/3101 -> 3100 reserved; 3101/3102 -> 3102 reserved; 3102/3103 -> 3102 reserved;
    // 3103/3104 is the first pair clear of both reservations.
    expect(pair).toEqual({ portA: 3103, portB: 3104 });
  });
});
