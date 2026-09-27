// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../app/App.js';
import { MockCore } from '../mock/MockCore.js';

const core = new MockCore('onboarded-empty', { delay: 0 });
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'bobDeploy');
  vi.restoreAllMocks();
});

it('prefills a project name from the chosen folder', async () => {
  Object.defineProperty(window, 'bobDeploy', {
    configurable: true,
    value: { pickFolder: vi.fn().mockResolvedValue('C:\\Sites\\my-portfolio') },
  });
  render(createElement(App, { transport: core, initialEntries: ['/projects/new'] }));
  fireEvent.click(await screen.findByRole('button', { name: 'Choose your project folder' }));
  expect(await screen.findByLabelText('Name')).toHaveValue('my-portfolio');
  expect(screen.getByRole('button', { name: 'Add project' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
  expect(await screen.findByRole('heading', { name: 'Where should my-portfolio run?' })).toBeVisible();
});

it('requires a folder before a project can be added', async () => {
  render(createElement(App, { transport: core, initialEntries: ['/projects/new'] }));
  expect(await screen.findByRole('button', { name: 'Add project' })).toBeDisabled();
  expect(screen.queryByText('String must contain at least 1 character(s)')).not.toBeInTheDocument();
});

it('explains that folder selection requires the desktop bridge', async () => {
  render(createElement(App, { transport: core, initialEntries: ['/projects/new'] }));
  fireEvent.click(await screen.findByRole('button', { name: 'Choose your project folder' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Open this screen in the Bob Deploy desktop app to choose a folder.',
  );
});

it('shows a useful error when the native folder chooser fails', async () => {
  Object.defineProperty(window, 'bobDeploy', {
    configurable: true,
    value: { pickFolder: vi.fn().mockRejectedValue(new Error('dialog failed')) },
  });
  render(createElement(App, { transport: core, initialEntries: ['/projects/new'] }));
  fireEvent.click(await screen.findByRole('button', { name: 'Choose your project folder' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The folder chooser could not open. Close it and try again.',
  );
});

it('connects Bob after adding a project when Bob is not configured', async () => {
  const missingBob = new MockCore('bob-missing', { delay: 0 });
  Object.defineProperty(window, 'bobDeploy', {
    configurable: true,
    value: { pickFolder: vi.fn().mockResolvedValue('C:\\Sites\\bob-vercel-test') },
  });
  render(createElement(App, { transport: missingBob, initialEntries: ['/projects/new'] }));
  fireEvent.click(await screen.findByRole('button', { name: 'Choose your project folder' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add project' }));

  expect(await screen.findByRole('heading', { name: 'Connect Bob to continue' })).toBeVisible();
  fireEvent.change(screen.getByLabelText('New API key'), { target: { value: 'test-bob-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Test and save' }));

  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Where should bob-vercel-test run?' })).toBeVisible(),
  );
});
