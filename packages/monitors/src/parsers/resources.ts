import type { MetricSample } from '@bob-deploy/contracts';
import { ParseError } from './errors.js';

function finite(section: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ParseError(section);
  return parsed;
}

export function parseResources(output: string, ts: string, projectId: string): MetricSample[] {
  const sections = output.trim().split(/\r?\n---BD---\r?\n/);
  if (sections.length !== 5) throw new ParseError('boundaries');
  const [memorySection, loadSection, processorSection, uptimeSection, diskSection] = sections as [string, string, string, string, string];

  const memoryLine = memorySection.split(/\r?\n/).find((line) => /^Mem:\s/.test(line));
  if (!memoryLine) throw new ParseError('memory');
  const memory = memoryLine.trim().split(/\s+/);
  const totalMb = finite('memory', memory[1]);
  const availableMb = finite('memory', memory[6]);
  if (totalMb <= 0 || availableMb < 0 || availableMb > totalMb) throw new ParseError('memory');
  const usedMb = totalMb - availableMb;

  const load1 = finite('load', loadSection.trim().split(/\s+/)[0]);
  const processors = finite('processors', processorSection.trim());
  if (processors <= 0) throw new ParseError('processors');
  const uptimeSeconds = finite('uptime', uptimeSection.trim().split(/\s+/)[0]);

  const diskLines = diskSection.trim().split(/\r?\n/);
  const disk = diskLines.find((line) => /^\//.test(line.trim()))?.trim().split(/\s+/);
  if (!disk || disk.length < 5) throw new ParseError('disk');
  const totalBytes = finite('disk', disk[1]);
  const usedBytes = finite('disk', disk[2]);
  const diskPercent = finite('disk', disk[4]?.replace('%', ''));

  return [
    { projectId, kind: 'memory', value: ((totalMb - availableMb) / totalMb) * 100, unit: '%', ts, meta: { usedMb, totalMb, uptimeSeconds } },
    { projectId, kind: 'cpu', value: Math.min(100, (load1 / processors) * 100), unit: '%', ts, meta: { load1, processors, uptimeSeconds } },
    { projectId, kind: 'disk', value: diskPercent, unit: '%', ts, meta: { usedBytes, totalBytes, uptimeSeconds } },
  ];
}
