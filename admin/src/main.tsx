import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { ConsolePreferencesProvider } from './components/ConsolePreferences';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConsolePreferencesProvider><App /></ConsolePreferencesProvider>
  </React.StrictMode>
);
