import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles.css';
import { readMarks } from './components/Rules.tsx';

// Applied before the first paint so the tiles never flash the wrong way.
document.documentElement.dataset.marks = readMarks() ? 'on' : 'off';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
