import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  HashRouter,
  MemoryRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import type { IpcTransport } from '@bob-deploy/contracts';
import { IpcProvider, useIpc } from '../ipc/context.js';
import { useAccountStatus, useProjects, useSettings } from '../ipc/hooks.js';
import {
  AnalyticsScreen,
  HealthScreen,
  HomeScreen,
  MaintenanceScreen,
  MemoryScreen,
  ProblemScreen,
} from '../screens/DashboardScreens.js';
import { ViewerScreen } from '../screens/ViewerScreen.js';
import { LockedToast, OnboardingFlow, RecoverScreen, UnlockScreen } from '../screens/AccountScreens.js';
import { DeployWizard, JobScreen } from '../screens/DeployScreens.js';
import { AddProjectScreen } from '../screens/ProjectScreens.js';
import { SettingsScreen } from '../screens/SettingsScreen.js';
import { ErrorState, Skeleton } from '../components/ui.js';
import { AppLayout } from './AppLayout.js';
import { useUiStore } from './store.js';

function ThemeSynchronizer() {
  const settings = useSettings();
  const setTheme = useUiStore((state) => state.setTheme);
  useEffect(() => {
    if (!settings.data) return;
    setTheme(settings.data.theme);
    const dark =
      settings.data.theme === 'dark' ||
      (settings.data.theme === 'system' &&
        typeof matchMedia === 'function' &&
        matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [setTheme, settings.data]);
  return null;
}

function ProtectedRoute() {
  const account = useAccountStatus();
  const location = useLocation();
  if (account.isLoading)
    return (
      <div className="app-loading">
        <Skeleton label="Opening Bob Deploy" />
      </div>
    );
  if (account.error)
    return (
      <main className="centered-page">
        <ErrorState message={account.error.message} retry={() => void account.refetch()} />
      </main>
    );
  if (!account.data?.exists) return <Navigate to="/welcome" replace state={{ from: location.pathname }} />;
  if (!account.data.unlocked) return <Navigate to="/unlock" replace state={{ from: location.pathname }} />;
  if (!account.data.onboardingComplete) return <Navigate to="/welcome" replace />;
  return <Outlet />;
}

function RootRedirect() {
  const account = useAccountStatus();
  const projects = useProjects();
  if (account.isLoading || projects.isLoading)
    return (
      <div className="app-loading">
        <Skeleton />
      </div>
    );
  if (!account.data?.exists) return <Navigate to="/welcome" replace />;
  if (!account.data.unlocked) return <Navigate to="/unlock" replace />;
  if (!account.data.onboardingComplete) return <Navigate to="/welcome" replace />;
  const first = projects.data?.[0];
  return <Navigate to={first ? `/p/${first.id}/home` : '/projects/new'} replace />;
}

function LockEventNavigator() {
  const navigate = useNavigate();
  const location = useLocation();
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    const onLocked = (event: Event) => {
      setLocked((event as CustomEvent<{ reason: 'manual' | 'idle' }>).detail?.reason === 'idle');
      void navigate('/unlock', { state: { from: location.pathname } });
      window.setTimeout(() => setLocked(false), 3_000);
    };
    window.addEventListener('bob-deploy:locked', onLocked);
    return () => window.removeEventListener('bob-deploy:locked', onLocked);
  }, [location.pathname, navigate]);
  return locked ? <LockedToast /> : null;
}

function ActivityToucher() {
  const ipc = useIpc();
  const lastTouch = useRef(0);
  useEffect(() => {
    const touch = () => {
      const now = Date.now();
      if (now - lastTouch.current < 30_000) return;
      lastTouch.current = now;
      void ipc['account:touch'](undefined);
    };
    window.addEventListener('keydown', touch);
    window.addEventListener('pointerdown', touch);
    return () => {
      window.removeEventListener('keydown', touch);
      window.removeEventListener('pointerdown', touch);
    };
  }, [ipc]);
  return null;
}

export function AppRoutes() {
  return (
    <>
      <ThemeSynchronizer />
      <LockEventNavigator />
      <ActivityToucher />
      <Routes>
        <Route path="/welcome/*" element={<OnboardingFlow />} />
        <Route path="/unlock" element={<UnlockScreen />} />
        <Route path="/recover" element={<RecoverScreen />} />
        <Route element={<ProtectedRoute />}>
          <Route
            path="/projects/new"
            element={
              <main className="standalone-content" id="main-content">
                <AddProjectScreen />
              </main>
            }
          />
          <Route path="/settings/*" element={<SettingsScreen />} />
          <Route path="/p/:projectId" element={<AppLayout />}>
            <Route index element={<Navigate to="home" replace />} />
            <Route path="home" element={<HomeScreen />} />
            <Route path="viewer" element={<ViewerScreen />} />
            <Route path="analytics" element={<AnalyticsScreen />} />
            <Route path="health" element={<HealthScreen />} />
            <Route path="memory" element={<MemoryScreen />} />
            <Route path="maintenance" element={<MaintenanceScreen />} />
            <Route path="problem" element={<ProblemScreen />} />
            <Route path="deploy" element={<DeployWizard />} />
            <Route path="jobs/:jobId" element={<JobScreen />} />
          </Route>
        </Route>
        <Route path="*" element={<RootRedirect />} />
      </Routes>
    </>
  );
}

export function App({ transport, initialEntries }: { transport?: IpcTransport; initialEntries?: string[] }) {
  const Router = initialEntries ? MemoryRouter : HashRouter;
  const routerProps = initialEntries ? { initialEntries } : {};
  return (
    <IpcProvider transport={transport}>
      <Router {...routerProps}>
        <AppRoutes />
      </Router>
    </IpcProvider>
  );
}

export function TestApp({
  transport,
  children,
  initialEntries = ['/'],
}: {
  transport: IpcTransport;
  children?: ReactNode;
  initialEntries?: string[];
}) {
  return (
    <IpcProvider transport={transport}>
      <MemoryRouter initialEntries={initialEntries}>{children ?? <AppRoutes />}</MemoryRouter>
    </IpcProvider>
  );
}
