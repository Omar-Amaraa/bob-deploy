import { describe, expect, it } from 'vitest';
import { decodeBobStreamLine, extractBobResponseText } from './stream.js';

describe('Bob Shell stream-json decoding', () => {
  it('keeps assistant output and never echoes the user prompt', () => {
    const user = JSON.stringify({ type: 'message', role: 'user', content: 'secret project context' });
    const assistant = JSON.stringify({ type: 'message', role: 'assistant', content: 'Inspecting package.json.' });
    expect(decodeBobStreamLine(user)).toEqual({});
    expect(decodeBobStreamLine(assistant)).toEqual({
      responseText: 'Inspecting package.json.',
      displayText: 'Inspecting package.json.',
      delta: true,
    });
    expect(extractBobResponseText(`${user}\n${assistant}\n`)).toBe('Inspecting package.json.');
  });

  it('turns tool events into readable progress', () => {
    expect(decodeBobStreamLine(JSON.stringify({ type: 'tool_use', name: 'read_file' }))).toMatchObject({
      displayText: 'Bob is reading a file',
    });
    expect(decodeBobStreamLine(JSON.stringify({ type: 'tool_use', name: 'mystery_tool' }))).toMatchObject({
      displayText: 'Bob is using mystery_tool',
    });
  });

  it('names the file, folder, search or command using Bob Shell tool_name + parameters, relative to the workspace', () => {
    const ws = 'C:\\Users\\me\\AppData\\staging\\abc\\project';
    const read = { type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { absolute_path: `${ws}\\package.json` } };
    expect(decodeBobStreamLine(JSON.stringify(read), { workspace: ws }).displayText).toBe('Bob is reading `package.json`');
    const list = { type: 'tool_use', tool_name: 'list_directory', parameters: { path: '/stage/project/src' } };
    expect(decodeBobStreamLine(JSON.stringify(list), { workspace: '/stage/project' }).displayText).toBe('Bob is looking inside `src`');
    const grep = { type: 'tool_use', tool_name: 'search_file_content', parameters: { pattern: 'listen(' } };
    expect(decodeBobStreamLine(JSON.stringify(grep)).displayText).toBe('Bob is searching the code for `listen(`');
    const shell = { type: 'tool_use', tool_name: 'run_shell_command', tool_id: 't9', parameters: { command: 'npm run build' } };
    expect(decodeBobStreamLine(JSON.stringify(shell))).toEqual({
      displayText: 'Bob is running `npm run build`',
      toolUse: { id: 't9', command: 'npm run build' },
    });
  });

  it('reports failed tool results, stays quiet on successful ones', () => {
    expect(decodeBobStreamLine(JSON.stringify({ type: 'tool_result', tool_id: 't9', status: 'success', output: 'lots of text' }))).toEqual({
      toolResult: { id: 't9', ok: true },
    });
    expect(
      decodeBobStreamLine(JSON.stringify({ type: 'tool_result', tool_id: 't9', status: 'error', error: { message: 'exit 1' } })),
    ).toEqual({ displayText: "That step didn't work: exit 1", toolResult: { id: 't9', ok: false, error: 'exit 1' } });
  });

  it('shows reasoning without treating it as the answer, and keeps streamed fragments marked as deltas', () => {
    const thinking = { type: 'message', role: 'assistant', content: 'package.json has a vite build script', isReasoning: true };
    expect(decodeBobStreamLine(JSON.stringify(thinking))).toEqual({ displayText: 'Bob is thinking: package.json has a vite build script' });
    const delta = { type: 'message', role: 'assistant', content: 'This is a Vi', delta: true };
    expect(decodeBobStreamLine(JSON.stringify(delta))).toEqual({ responseText: 'This is a Vi', displayText: 'This is a Vi', delta: true });
  });

  it('joins deltas without inserting line breaks and exposes the final result message', () => {
    const lines = [
      { type: 'message', role: 'assistant', content: 'Hel', delta: true },
      { type: 'message', role: 'assistant', content: 'lo', delta: true },
    ].map((l) => JSON.stringify(l));
    expect(extractBobResponseText(lines.join('\n'))).toBe('Hello');
    expect(decodeBobStreamLine(JSON.stringify({ type: 'result', status: 'success', last_message: 'done' }))).toEqual({ finalText: 'done' });
  });

  it('decodes the real Bob Shell 2.0.1 stream-json shape: assistant chunks carry no delta flag', () => {
    // Shape copied from bobshell 2.0.1 dist/bob.js, stream-json renderer `onStream`:
    // {type:"message",timestamp,isReasoning,role:"assistant",content}. The final `result` event only
    // carries stats, never the message, so these chunks are the only copy of Bob's answer.
    const ts = '2026-09-26T18:37:20.000Z';
    const chunks = ['BO', 'B_DEPLOY_RESULT_', 'BEGIN\n{"', 'type":"static","outputDir":', '".","needsBackend":false', '}\nBOB_DEPLOY_', 'RESULT_END'];
    const stdout = [
      ...chunks.map((content) => ({ type: 'message', timestamp: ts, isReasoning: false, role: 'assistant', content })),
      { type: 'result', timestamp: ts, status: 'success', stats: { task_id: 't', duration_ms: 1, session_costs: 0, max_cost: 0, tool_calls: 0 } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    expect(extractBobResponseText(stdout)).toBe(
      'BOB_DEPLOY_RESULT_BEGIN\n{"type":"static","outputDir":".","needsBackend":false}\nBOB_DEPLOY_RESULT_END',
    );
  });
});
