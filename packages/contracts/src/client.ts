import type { Result } from './common.js';
import {
  IPC_CHANNELS,
  type IpcChannel,
  type IpcContract,
  type IpcTransport,
  type PushEvent,
  type PushEvents,
} from './ipc.js';
import { IPC_OUTPUT_SCHEMAS } from './schemas.js';

export type IpcClient = {
  [C in IpcChannel]: (input: IpcContract[C]['in']) => Promise<Result<IpcContract[C]['out']>>;
} & {
  on<E extends PushEvent>(event: E, listener: (p: PushEvents[E]) => void): () => void;
};

function isDevMode(): boolean {
  const meta = import.meta as ImportMeta & { env?: { DEV?: boolean } };
  if (typeof meta.env?.DEV === 'boolean') return meta.env.DEV;
  const nodeEnv = globalThis.process?.env?.['NODE_ENV'];
  return nodeEnv !== 'production';
}

/**
 * Builds the typed IPC client the UI uses. Every method calls `transport.invoke(channel, input)` and
 * returns the `Result<out>` it resolves to. In dev builds (or whenever `NODE_ENV !== 'production'`),
 * a successful `data` payload is additionally checked against the channel's output schema (when one is
 * registered in `IPC_OUTPUT_SCHEMAS`); a mismatch is turned into an `{ ok: false, error: { code: 'INTERNAL' } }`
 * result rather than handing the UI a shape it doesn't expect.
 */
export function createIpcClient(transport: IpcTransport): IpcClient {
  const client = {} as IpcClient;
  const validateOutputs = isDevMode();

  for (const channel of IPC_CHANNELS) {
    (client as unknown as Record<string, unknown>)[channel] = async (
      input: IpcContract[typeof channel]['in'],
    ): Promise<Result<IpcContract[typeof channel]['out']>> => {
      const raw = (await transport.invoke(channel, input)) as Result<IpcContract[typeof channel]['out']>;

      if (validateOutputs && raw.ok) {
        const outputSchema = IPC_OUTPUT_SCHEMAS[channel];
        if (outputSchema) {
          const parsed = outputSchema.safeParse(raw.data);
          if (!parsed.success) {
            return {
              ok: false,
              error: {
                code: 'INTERNAL',
                message: `Received an unexpected shape for "${channel}".`,
                details: { channel, issues: parsed.error.issues },
              },
            };
          }
        }
      }

      return raw;
    };
  }

  client.on = <E extends PushEvent>(event: E, listener: (p: PushEvents[E]) => void): (() => void) =>
    transport.on(event, listener as (payload: unknown) => void);

  return client;
}
