import {
  Activity,
  BarChart3,
  CircleHelp,
  Eye,
  Gauge,
  HeartPulse,
  Home,
  Lock,
  Settings,
  Wrench,
} from 'lucide-react';
import { useEffect, type KeyboardEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Pill, Skeleton } from '../components/ui.js';
import { BrandLogo } from '../components/BrandLogo.js';
import { useIpc } from '../ipc/context.js';
import { useProjects } from '../ipc/hooks.js';
import { useUiStore } from './store.js';

const sections = [
  { path: 'home', label: 'Home', icon: Home },
  { path: 'viewer', label: 'Live viewer', icon: Eye },
  { path: 'analytics', label: 'Analytics', icon: BarChart3 },
  { path: 'health', label: 'Health', icon: HeartPulse },
  { path: 'memory', label: 'Memory use', icon: Gauge },
  { path: 'maintenance', label: 'Maintenance', icon: Wrench },
] as const;

const titles: Record<string, string> = {
  home: 'Home', viewer: 'Live viewer', analytics: 'Analytics', health: 'Health', memory: 'Memory use', maintenance: 'Maintenance', problem: 'Signal a problem', deploy: 'Put project online', jobs: 'Task progress',
};

export function AppLayout() {
  const { projectId = '' } = useParams();
  const projects = useProjects();
  const navigate = useNavigate();
  const location = useLocation();
  const ipc = useIpc();
  const selectProject = useUiStore((state) => state.selectProject);
  const project = projects.data?.find((item) => item.id === projectId);
  const currentSection = location.pathname.split('/').at(-1) ?? 'home';

  useEffect(() => {
    if (projectId) selectProject(projectId);
  }, [projectId, selectProject]);

  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const index = Number(event.key) - 1;
      const section = sections[index];
      if (!section || !projectId) return;
      event.preventDefault();
      void navigate(`/p/${projectId}/${section.path}`);
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [navigate, projectId]);

  function moveSidebarFocus(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const links = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-nav-item]:not([aria-disabled="true"])')];
    const index = links.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    links[(index + direction + links.length) % links.length]?.focus();
  }

  async function lockNow() {
    await ipc['account:lock']();
    void navigate('/unlock');
  }

  if (projects.isLoading) return <div className="app-loading"><Skeleton label="Loading workspace" /></div>;

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="sidebar">
        <div className="brand"><BrandLogo compact /><span className="nav-label">Bob Deploy</span></div>
        <label className="project-picker">
          <span className="sr-only">Project</span>
          <select value={projectId} onChange={(event) => { void (event.target.value === 'new' ? navigate('/projects/new') : navigate(`/p/${event.target.value}/home`)); }}>
            {projects.data?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            <option value="new">Add project</option>
          </select>
        </label>
        {project ? <Pill tone={project.status === 'live' ? 'good' : project.status === 'down' ? 'bad' : 'neutral'}>{project.status === 'live' ? 'Live' : project.status === 'down' ? 'Down' : project.status === 'deploying' ? 'Deploying' : project.status === 'error' ? 'Error' : 'Not deployed'}</Pill> : null}
        <nav aria-label="Project sections" className="sidebar-nav" onKeyDown={moveSidebarFocus}>
          {sections.map(({ path, label, icon: Icon }) => {
            const disabled = path === 'memory' && project?.target?.kind !== 'own_server';
            return <NavLink key={path} data-nav-item to={`/p/${projectId}/${path}`} aria-disabled={disabled} title={disabled ? 'Your host manages the server for this site.' : label} onClick={(event) => { if (disabled) event.preventDefault(); }} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''} ${disabled ? 'disabled' : ''}`}><Icon aria-hidden="true" /><span className="nav-label">{label}</span></NavLink>;
          })}
          <div className="nav-spacer" />
          <NavLink data-nav-item to={`/p/${projectId}/problem`} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><CircleHelp aria-hidden="true" /><span className="nav-label">Signal a problem</span></NavLink>
        </nav>
      </aside>
      <div className="content-column">
        <header className="topbar"><div><p className="eyebrow">{project?.name ?? 'Bob Deploy'}</p><h1>{titles[currentSection] ?? 'Bob Deploy'}</h1></div><div className="topbar-actions"><button className="icon-button" aria-label="Settings" onClick={() => { void navigate('/settings/account'); }}><Settings aria-hidden="true" /></button><button className="icon-button" aria-label="Lock Bob Deploy" onClick={() => void lockNow()}><Lock aria-hidden="true" /></button></div></header>
        {project?.status === 'down' ? <div className="notice"><Activity aria-hidden="true" />Your site is not answering. Showing the last information we received.</div> : null}
        <main id="main-content" className="main-content" tabIndex={-1}><Outlet /></main>
      </div>
    </div>
  );
}
