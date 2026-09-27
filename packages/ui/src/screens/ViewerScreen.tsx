import { ArrowLeft, ArrowRight, ExternalLink, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType, type Ref } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, EmptyState, ErrorState, Skeleton, Toast } from '../components/ui.js';
import { useHealth, useProjects } from '../ipc/hooks.js';
import { isTestbedSiteUrl } from '../utils/site-url.js';

interface ViewerElement extends HTMLElement {
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  goBack(): void;
  goForward(): void;
  reload(): void;
}

interface ViewerProps {
  ref?: Ref<ViewerElement>;
  src: string;
  partition: string;
  className: string;
  title: string;
}

const Webview = 'webview' as unknown as ComponentType<ViewerProps>;

function safeCall<T>(viewer: ViewerElement | null, method: (element: ViewerElement) => T, fallback: T): T {
  try {
    return viewer ? method(viewer) : fallback;
  } catch {
    return fallback;
  }
}

export function ViewerScreen() {
  const { projectId = '' } = useParams();
  const projects = useProjects();
  const health = useHealth(projectId);
  const project = projects.data?.find((item) => item.id === projectId);
  const siteUrl = project?.target?.siteUrl;
  const localTestSite = siteUrl ? isTestbedSiteUrl(siteUrl) : false;
  const viewerRef = useRef<ViewerElement>(null);
  const [currentUrl, setCurrentUrl] = useState(siteUrl ?? '');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [viewerKey, setViewerKey] = useState(0);
  const [openedOutside, setOpenedOutside] = useState(false);

  useEffect(() => {
    if (!siteUrl) return;
    setCurrentUrl(siteUrl);
    setLoadFailed(false);
  }, [siteUrl]);

  useEffect(() => {
    const bridge = window.bobDeploy;
    if (!bridge) return;
    return bridge.onViewerExternalOpened(() => {
      setOpenedOutside(true);
      window.setTimeout(() => setOpenedOutside(false), 2_000);
    });
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const updateNavigation = (event?: Event) => {
      const eventUrl = event && 'url' in event && typeof event.url === 'string' ? event.url : undefined;
      setCurrentUrl(eventUrl ?? safeCall(viewer, (element) => element.getURL(), siteUrl ?? ''));
      setCanGoBack(safeCall(viewer, (element) => element.canGoBack(), false));
      setCanGoForward(safeCall(viewer, (element) => element.canGoForward(), false));
    };
    const loaded = (event: Event) => {
      setLoadFailed(false);
      updateNavigation(event);
    };
    const failed = (event: Event) => {
      if ((event as Event & { errorCode?: number }).errorCode !== -3) setLoadFailed(true);
    };
    viewer.addEventListener('dom-ready', updateNavigation);
    viewer.addEventListener('did-navigate', updateNavigation);
    viewer.addEventListener('did-navigate-in-page', updateNavigation);
    viewer.addEventListener('did-finish-load', loaded);
    viewer.addEventListener('did-fail-load', failed);
    return () => {
      viewer.removeEventListener('dom-ready', updateNavigation);
      viewer.removeEventListener('did-navigate', updateNavigation);
      viewer.removeEventListener('did-navigate-in-page', updateNavigation);
      viewer.removeEventListener('did-finish-load', loaded);
      viewer.removeEventListener('did-fail-load', failed);
    };
  }, [siteUrl, viewerKey]);

  if (projects.isLoading) return <Skeleton label="Loading live viewer" />;
  if (projects.error) return <ErrorState message={projects.error.message} retry={() => void projects.refetch()} />;
  if (!siteUrl) return <EmptyState title="Put this project online first" body="The live viewer appears after your first publish." action={<Link className="button link-button" to="../deploy">Put project online</Link>} />;
  if (health.isLoading) return <Skeleton label="Checking your site" />;
  if (health.error) return <ErrorState message={health.error.message} retry={() => void health.refetch()} />;

  const offline = loadFailed || health.data?.up === false;
  const retry = async () => {
    const result = await health.refetch();
    if (result.data?.up) {
      setLoadFailed(false);
      setViewerKey((value) => value + 1);
    }
  };

  return <div className="viewer-shell">
    <div className="viewer-toolbar" aria-label="Live viewer controls">
      <button className="icon-button" aria-label="Back" disabled={!canGoBack} onClick={() => viewerRef.current?.goBack()}><ArrowLeft aria-hidden="true" /></button>
      <button className="icon-button" aria-label="Forward" disabled={!canGoForward} onClick={() => viewerRef.current?.goForward()}><ArrowRight aria-hidden="true" /></button>
      <button className="icon-button" aria-label="Reload" onClick={() => viewerRef.current?.reload()}><RefreshCw aria-hidden="true" /></button>
      <label className="viewer-address"><span className="sr-only">Current address</span><input aria-label="Current address" readOnly value={currentUrl} /></label>
      <Button
        className="button-secondary"
        disabled={localTestSite}
        title={localTestSite ? 'Local test sites open only inside Bob Deploy.' : undefined}
        onClick={() => void window.bobDeploy?.openExternal(currentUrl || siteUrl)}
      >
        <ExternalLink aria-hidden="true" />
        {localTestSite ? 'Local test site' : 'Open in browser'}
      </Button>
    </div>
    {offline ? <EmptyState title="Your site is not answering right now." body="Try again, or check the site health for more information." action={<div className="button-row"><Button onClick={() => void retry()}>Retry</Button><Link className="button link-button button-secondary" to="../health">Go to Health</Link></div>} /> : <Webview key={viewerKey} ref={viewerRef} className="live-webview" title={`Live view of ${project.name}`} src={siteUrl} partition="persist:liveviewer" />}
    {openedOutside ? <Toast>Opened in your browser</Toast> : null}
  </div>;
}
