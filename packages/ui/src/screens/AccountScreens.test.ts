// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App.js';
import { MockCore, type MockScenario } from '../mock/MockCore.js';

const cores: MockCore[] = [];
function renderAt(scenario: MockScenario, path: string) {
  const core = new MockCore(scenario, { delay: 0 });
  cores.push(core);
  render(createElement(App, { transport: core, initialEntries: [path] }));
  return core;
}

function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

afterEach(() => {
  cleanup();
  for (const core of cores.splice(0)) core.dispose();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'bobDeploy');
});

describe('onboarding', () => {
  it('shows the supplied Bob Deploy logo', async () => {
    renderAt('fresh', '/welcome');
    await screen.findByRole('heading', { name: 'Put your AI-built site online in a few clicks.' });
    expect(document.querySelector('img.brand-logo')).toBeVisible();
  });

  it('validates account creation and confirms the one-time recovery code', async () => {
    renderAt('fresh', '/welcome/account');
    const create = screen.getByRole('button', { name: 'Create account' });
    expect(create).toBeDisabled();
    change('Your name', 'Ada Example');
    change('Email', 'ada@example.test');
    change('Master password', 'Correct horse battery staple! 42');
    change('Confirm password', 'Correct horse battery staple! 42');
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    expect(await screen.findByRole('heading', { name: 'Save your recovery code' })).toBeVisible();
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();
    change('Type the last 4 characters to confirm', 'WXYZ');
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);
    expect(await screen.findByRole('heading', { name: 'Connect Bob' })).toBeVisible();
  });

  it('shows specific Bob fixes and allows skipping to hosting and All set', async () => {
    renderAt('bob-missing', '/welcome/bob');
    expect((await screen.findAllByText('Open install guide', { selector: 'button' }))[0]).toBeVisible();
    expect(screen.getByText(/Your key was not accepted/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByRole('heading', { name: 'Free hosting (optional)' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByRole('heading', { name: 'All set' })).toBeVisible();
  });

  it('tests and saves Bob without retaining the API key field', async () => {
    renderAt('bob-missing', '/welcome/bob');
    const apiKey = await screen.findByLabelText('API key');
    fireEvent.change(apiKey, { target: { value: 'mock-key-that-is-never-logged' } });
    fireEvent.click(screen.getByLabelText(/accept IBM Bob's license terms/i));
    fireEvent.click(screen.getByRole('button', { name: 'Test and save' }));
    expect(await screen.findByText(/Key saved/)).toBeVisible();
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('maps a rejected hosting token to plain language', async () => {
    renderAt('fresh', '/welcome/hosting');
    const tokens = screen.getAllByLabelText('Token');
    fireEvent.change(tokens[0] as HTMLInputElement, { target: { value: 'bad-token' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0] as HTMLButtonElement);
    expect(await screen.findByText('That token was not accepted.')).toBeVisible();
  });

  it('shows the connected hosting account and clears the token field', async () => {
    renderAt('fresh', '/welcome/hosting');
    const tokens = screen.getAllByLabelText('Token');
    fireEvent.change(tokens[0] as HTMLInputElement, { target: { value: 'valid-token' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0] as HTMLButtonElement);
    expect(await screen.findByText('Connected as Ada Example')).toBeVisible();
    expect(screen.getAllByLabelText('Token')).toHaveLength(1);
  });
});

describe('unlock and recovery', () => {
  it('focuses unlock, reports a wrong password, then accepts the right password', async () => {
    renderAt('locked', '/unlock');
    const password = await screen.findByLabelText('Master password');
    expect(password).toHaveFocus();
    fireEvent.change(password, { target: { value: 'wrong password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('That password is not right.')).toBeVisible();
    fireEvent.change(password, { target: { value: 'correct horse battery staple' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: /Welcome back/ })).not.toBeInTheDocument());
  });

  it('disables unlock and shows a countdown after too many attempts', async () => {
    renderAt('locked', '/unlock');
    const password = await screen.findByLabelText('Master password');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      fireEvent.change(password, { target: { value: `wrong password ${attempt}` } });
      fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
      await waitFor(() => expect(password).toHaveValue(''));
    }
    expect(await screen.findByRole('button', { name: /Try again in 0:/ })).toBeDisabled();
  });

  it('normalises a recovery code and shows the replacement code', async () => {
    renderAt('locked', '/recover');
    change('Recovery code', '0123-4567 89ab-cdef ghjk-mnpq rstv-wxyz');
    change('New password', 'A very strong replacement password! 42');
    change('Confirm new password', 'A very strong replacement password! 42');
    const reset = screen.getByRole('button', { name: 'Reset password' });
    await waitFor(() => expect(reset).toBeEnabled());
    fireEvent.click(reset);
    expect(await screen.findByRole('heading', { name: 'Save your new recovery code' })).toBeVisible();
  });

  it('shows and hides passwords and warns about Caps Lock', () => {
    renderAt('locked', '/unlock');
    const password = screen.getByLabelText('Master password');
    const capsEvent = new KeyboardEvent('keydown', { key: 'A', bubbles: true });
    Object.defineProperty(capsEvent, 'getModifierState', { value: (key: string) => key === 'CapsLock' });
    fireEvent(password, capsEvent);
    expect(screen.getByText('Caps Lock is on.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
  });
});
