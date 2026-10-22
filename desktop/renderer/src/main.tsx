import './styles.css';
import '@app-patterns/updates-react/updates.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
