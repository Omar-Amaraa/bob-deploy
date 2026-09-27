import type { RemoteExec } from '../ssh/types.js';

const MIN_PORT = 3100;
const MAX_PORT = 3100 + 500; // generous, fixed search window; a server hosting >250 apps is out of scope

/** Parses `ss -ltnH` output into the set of local ports already bound (any address). */
export function parseListeningPorts(ssOutput: string): Set<number> {
  const ports = new Set<number>();
  for (const line of ssOutput.split('\n')) {
    // Example line: "LISTEN 0      511          0.0.0.0:3100        0.0.0.0:*"
    const match = /:(\d+)\s+[^\s]+\s*$/.exec(line.trim());
    if (match?.[1]) ports.add(Number(match[1]));
  }
  return ports;
}

/**
 * Step 8's port allocation: the first free pair (p, p+1), both >= 3100, neither already listening
 * on the server (per `ss -ltnH`) nor already recorded as in use by another app on this server
 * (`usedByOtherTargets`, supplied by the caller — ssh-playbooks has no DB of its own; that's core's
 * job in A9). Ports are allocated in pairs so a blue/green release always has room for the old and
 * new instance to run side by side.
 */
export async function findFreePortPair(
  session: RemoteExec,
  usedByOtherTargets: readonly number[] = [],
): Promise<{ portA: number; portB: number } | undefined> {
  const result = await session.exec('ss -ltnH');
  const listening = parseListeningPorts(result.stdout);
  const reserved = new Set(usedByOtherTargets);

  for (let p = MIN_PORT; p < MAX_PORT; p++) {
    const a = p;
    const b = p + 1;
    if (listening.has(a) || listening.has(b) || reserved.has(a) || reserved.has(b)) continue;
    return { portA: a, portB: b };
  }
  return undefined;
}
