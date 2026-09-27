import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Bob Deploy could not find its app container.');

createRoot(root).render(<StrictMode><App /></StrictMode>);
