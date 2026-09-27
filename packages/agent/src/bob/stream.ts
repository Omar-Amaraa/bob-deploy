function textContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return undefined;
      const record = part as Record<string, unknown>;
      return typeof record.text === 'string' ? record.text : undefined;
    })
    .filter((part): part is string => Boolean(part));
  return parts.length ? parts.join('\n') : undefined;
}

/** A tool call Bob started, reduced to what the job log needs to show. */
export interface BobToolUse {
  id?: string;
  /** Set only for shell commands, so the runner can report them as `command` events once the
   * matching tool_result arrives with a status. */
  command?: string;
}

export interface BobToolResult {
  id?: string;
  ok: boolean;
  error?: string;
}

export interface BobStreamLine {
  /** Assistant answer text: collected and parsed for the RESULT block. */
  responseText?: string;
  /** Plain-language progress for the job log. */
  displayText?: string;
  /** True when the assistant text is a streamed fragment of a longer message (no line break of its
   * own), so the runner must concatenate rather than treat it as a finished line. */
  delta?: boolean;
  toolUse?: BobToolUse;
  toolResult?: BobToolResult;
  /** `last_message` from the final `result` event: a fallback answer when no assistant message
   * events were streamed. */
  finalText?: string;
}

export interface DecodeOptions {
  /** The staging folder Bob works in; stripped from paths so the log shows `src/app.ts`, not the
   * user's full profile path. */
  workspace?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function shortenPath(path: string, workspace?: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (workspace) {
    const root = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized === root) return '.';
    if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return normalized.slice(root.length + 1);
  }
  return normalized;
}

function clip(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Turns a Bob Shell tool call into one readable sentence. Bob Shell's stream-json `tool_use` event
 * carries `tool_name` + `parameters` (docs: start-bobshell-non-interactive); older builds used
 * `name`/`toolName`/`input`, which are still accepted.
 */
export function describeBobTool(
  toolName: string | undefined,
  params: Record<string, unknown>,
  workspace?: string,
): { text: string; command?: string } {
  const name = (toolName ?? '').toLowerCase();
  const path =
    str(params.file_path) ?? str(params.absolute_path) ?? str(params.path) ?? str(params.dir_path) ?? str(params.directory);
  const shownPath = path ? `\`${shortenPath(path, workspace)}\`` : undefined;
  const paths = Array.isArray(params.paths)
    ? params.paths.filter((p): p is string => typeof p === 'string').map((p) => `\`${shortenPath(p, workspace)}\``)
    : [];
  const pattern = str(params.pattern) ?? str(params.query);
  const command = str(params.command) ?? str(params.cmd);

  if (/shell|bash|exec|run_command|terminal/.test(name) && command) {
    return { text: `Bob is running \`${clip(command, 200)}\``, command: clip(command, 500) };
  }
  if (/read_many|read_multiple/.test(name)) {
    return {
      text: paths.length ? `Bob is reading ${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ` and ${paths.length - 5} more` : ''}` : 'Bob is reading several files',
    };
  }
  if (/read|view|cat|open/.test(name)) return { text: shownPath ? `Bob is reading ${shownPath}` : 'Bob is reading a file' };
  if (/list|ls|tree/.test(name)) return { text: shownPath ? `Bob is looking inside ${shownPath}` : 'Bob is looking at the project folder' };
  if (/glob|find/.test(name)) return { text: pattern ? `Bob is looking for files matching \`${clip(pattern, 80)}\`` : 'Bob is looking for files' };
  if (/grep|search/.test(name)) return { text: pattern ? `Bob is searching the code for \`${clip(pattern, 80)}\`` : 'Bob is searching the code' };
  if (/write|edit|replace|patch|create/.test(name)) return { text: shownPath ? `Bob is editing ${shownPath}` : 'Bob is editing a file' };
  if (command) return { text: `Bob is running \`${clip(command, 200)}\``, command: clip(command, 500) };
  return { text: toolName ? `Bob is using ${toolName}` : 'Bob is using a tool' };
}

/** Converts Bob Shell's stream-json protocol to safe, user-facing progress and response text. */
export function decodeBobStreamLine(line: string, options: DecodeOptions = {}): BobStreamLine {
  const trimmed = line.trim();
  if (!trimmed) return {};
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!value || typeof value !== 'object') return {};
    const event = value as Record<string, unknown>;
    const role = typeof event.role === 'string' ? event.role : undefined;
    const content = textContent(event.content) ?? textContent(event.message);
    // Never echo the user's prompt or project/log context back into job logs.
    if (role === 'user') return {};
    if (role === 'assistant' && content) {
      if (event.isReasoning === true) {
        // Bob's thinking is useful to watch, but it is not the answer and must not be parsed.
        return { displayText: `Bob is thinking: ${clip(content, 300)}` };
      }
      // Bob Shell 2.0.1's stream-json renderer (onStream) emits every assistant text chunk as
      // {type:"message",role:"assistant",content,isReasoning} with no `delta` field, and never emits
      // the assembled message. So assistant text is a fragment unless explicitly marked otherwise.
      return { responseText: content, displayText: content, ...(event.delta === false ? {} : { delta: true }) };
    }

    const type = typeof event.type === 'string' ? event.type : '';
    const toolName = str(event.tool_name) ?? str(event.toolName) ?? str(event.name);
    const toolId = str(event.tool_id) ?? str(event.toolId) ?? str(event.id);
    if (/tool[_-]?(use|call|start)/i.test(type)) {
      const rawParams = event.parameters ?? event.input ?? event.args ?? {};
      const params = rawParams && typeof rawParams === 'object' ? (rawParams as Record<string, unknown>) : {};
      const described = describeBobTool(toolName, params, options.workspace);
      return {
        displayText: described.text,
        toolUse: { ...(toolId ? { id: toolId } : {}), ...(described.command ? { command: described.command } : {}) },
      };
    }
    if (/tool[_-]?(result|end|complete)/i.test(type)) {
      const status = str(event.status)?.toLowerCase();
      const ok = status === undefined ? event.error === undefined : status === 'success' || status === 'ok';
      const errorValue = event.error;
      const errorText =
        typeof errorValue === 'string'
          ? errorValue
          : errorValue && typeof errorValue === 'object' && typeof (errorValue as Record<string, unknown>).message === 'string'
            ? ((errorValue as Record<string, unknown>).message as string)
            : undefined;
      return {
        ...(ok ? {} : { displayText: errorText ? `That step didn't work: ${clip(errorText)}` : "That step didn't work." }),
        toolResult: { ...(toolId ? { id: toolId } : {}), ok, ...(errorText ? { error: clip(errorText) } : {}) },
      };
    }
    if (type === 'error') {
      const message = str(event.message);
      return message ? { displayText: `Bob reported a problem: ${clip(message)}` } : {};
    }
    // The final `result` event repeats the last message; the stats are not useful to the user.
    if (type === 'result') {
      const last = textContent(event.last_message);
      return last ? { finalText: last } : {};
    }
    if (type === 'init') return {};
    return content ? { displayText: content } : {};
  } catch {
    // Keeps compatibility with older/plain output and makes unexpected CLI diagnostics visible.
    return { responseText: line, displayText: line };
  }
}

export function extractBobResponseText(stdout: string): string {
  let text = '';
  for (const line of stdout.split(/\r?\n/)) {
    const decoded = decodeBobStreamLine(line);
    if (!decoded.responseText) continue;
    text += decoded.delta ? decoded.responseText : `${text && !text.endsWith('\n') ? '\n' : ''}${decoded.responseText}`;
  }
  return text;
}
