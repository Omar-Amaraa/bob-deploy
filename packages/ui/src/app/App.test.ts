// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { MockCore } from '../mock/MockCore.js';
import { App } from './App.js';

const cores: MockCore[] = [];
function renderScenario(scenario: ConstructorParameters<typeof MockCore>[0], path = '/') {
  const core = new MockCore(scenario, { delay: 0 });
  cores.push(core);
  return render(createElement(App, { transport: core, initialEntries: [path] }));
}

afterEach(() => {
  for (const core of cores.splice(0)) core.dispose();
  document.documentElement.removeAttribute('data-theme');
});

describe('router guards', () => {
  it('sends a fresh install to welcome', async () => {
    renderScenario('fresh');
    expect(await screen.findByRole('heading', { name: /put your ai-built site online/i })).toBeVisible();
  });

  it('sends a locked account to unlock', async () => {
    renderScenario('locked', '/p/project-own/home');
    expect(await screen.findByRole('heading', { name: /Welcome back/ })).toBeVisible();
  });

  it('sends an account without projects to add project', async () => {
    renderScenario('onboarded-empty');
    expect(await screen.findByRole('heading', { name: 'Add a project' })).toBeVisible();
  });
});

describe('sidebar', () => {
  it('moves focus with arrow keys and exposes all seven sections', async () => {
    renderScenario('live-own-server', '/p/project-own/home');
    const navigation = await screen.findByRole('navigation', { name: 'Project sections' });
    const home = screen.getByRole('link', { name: 'Home' });
    const viewer = screen.getByRole('link', { name: 'Live viewer' });
    home.focus();
    fireEvent.keyDown(home, { key: 'ArrowDown' });
    expect(viewer).toHaveFocus();
    expect(navigation.querySelectorAll('[data-nav-item]')).toHaveLength(7);
  });
});

describe('theme', () => {
  it('applies the theme returned by settings', async () => {
    const core = new MockCore('live-own-server', { delay: 0 });
    cores.push(core);
    await core.invoke('settings:set', { theme: 'dark' });
    render(createElement(App, { transport: core, initialEntries: ['/p/project-own/home'] }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
  });
});
