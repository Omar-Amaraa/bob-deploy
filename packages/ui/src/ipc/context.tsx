import { createIpcClient, type IpcClient, type IpcTransport } from '@bob-deploy/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { createTransport } from './transport.js';

const IpcContext = createContext<IpcClient | undefined>(undefined);

export function IpcProvider({ children, transport }: { children: ReactNode; transport?: IpcTransport }) {
  const selectedTransport = useMemo(() => transport ?? createTransport(), [transport]);
  const client = useMemo(() => createIpcClient(selectedTransport), [selectedTransport]);
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }),
    [],
  );

  useEffect(() => {
    const unsubscribeMetrics = client.on('metrics:updated', ({ projectId }) => {
      void queryClient.invalidateQueries({ queryKey: ['project-data', projectId] });
    });
    const unsubscribeStatus = client.on('project:status', () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    });
    const unsubscribeLocked = client.on('account:locked', (payload) => {
      queryClient.clear();
      window.dispatchEvent(new CustomEvent('bob-deploy:locked', { detail: payload }));
    });
    return () => {
      unsubscribeMetrics();
      unsubscribeStatus();
      unsubscribeLocked();
      queryClient.clear();
    };
  }, [client, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <IpcContext.Provider value={client}>{children}</IpcContext.Provider>
    </QueryClientProvider>
  );
}

export function useIpc(): IpcClient {
  const client = useContext(IpcContext);
  if (!client) throw new Error('useIpc must be used inside IpcProvider.');
  return client;
}
