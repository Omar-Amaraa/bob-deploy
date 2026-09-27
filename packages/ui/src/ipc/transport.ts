import type { IpcTransport } from '@bob-deploy/contracts';
import { MockCore, scenarioFromUrl, type MockScenario } from '../mock/MockCore.js';

let mockCore: MockCore | undefined;

export function createTransport(scenario?: MockScenario): IpcTransport {
  if (window.bobDeploy && !window.bobDeploy.mock) return window.bobDeploy;
  const siteUrl = new URLSearchParams(window.location.search).get('viewerUrl') ?? undefined;
  mockCore ??= new MockCore(scenario ?? scenarioFromUrl(), { siteUrl });
  return mockCore;
}

export function resetMockTransport(): void {
  mockCore?.dispose();
  mockCore = undefined;
}
