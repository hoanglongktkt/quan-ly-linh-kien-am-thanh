import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import DevicePreviewShell from './components/DevicePreviewShell.tsx';
import { installApiFetchInterceptor } from './utils/apiClient.ts';
import './index.css';

installApiFetchInterceptor();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {import.meta.env.DEV ? (
      <DevicePreviewShell>
        <App />
      </DevicePreviewShell>
    ) : (
      <App />
    )}
  </StrictMode>,
);
