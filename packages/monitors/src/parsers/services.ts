export function parseServices(output: string): string[] {
  const failed: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (!columns[0]) continue;
    const active = columns[2];
    const sub = columns[3];
    if (active === 'failed' || sub === 'failed' || sub === 'auto-restart') failed.push(columns[0]);
  }
  return failed;
}
