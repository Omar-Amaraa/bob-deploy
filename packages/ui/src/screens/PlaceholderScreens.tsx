import { Link } from 'react-router-dom';
import { useState } from 'react';
import { Button, Card } from '../components/ui.js';
import { BrandLogo } from '../components/BrandLogo.js';

export function WelcomePlaceholder() {
  return <main className="centered-page" id="main-content"><Card className="welcome-card"><BrandLogo /><p className="eyebrow">Bob Deploy</p><h1>Put your AI-built site online in a few clicks.</h1><p>Set up a local account, connect Bob, and publish without editing configuration files.</p><Link className="button link-button" to="/welcome/account">Get started</Link></Card></main>;
}

export function UnlockPlaceholder() {
  return <main className="centered-page" id="main-content"><Card className="welcome-card"><p className="eyebrow">Bob Deploy</p><h1>Welcome back</h1><p>The complete unlock form arrives in B11.</p><Link className="button link-button" to="/">Return to the app</Link></Card></main>;
}

export function RecoverPlaceholder() {
  return <main className="centered-page" id="main-content"><Card className="welcome-card"><h1>Recover your account</h1><p>The recovery-code flow arrives in B11.</p></Card></main>;
}

export function AddProjectPlaceholder() {
  return <Card><h1>Add a project</h1><p>Choose a project folder to begin. The complete form arrives with the deploy flow.</p><Button>Choose project folder</Button></Card>;
}

export function SettingsPlaceholder() {
  const [cleared, setCleared] = useState(false);
  return <Card><h1>Settings</h1><p>Account, Bob, hosting and appearance settings arrive in B12.</p><h2>About</h2><Button onClick={() => { void window.bobDeploy?.clearViewerData().then(() => setCleared(true)); }}>Clear viewer data</Button>{cleared ? <p role="status">Viewer data cleared</p> : null}</Card>;
}
