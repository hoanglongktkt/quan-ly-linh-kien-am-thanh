import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import DevicePreviewShell from './components/DevicePreviewShell.tsx';
import { installApiFetchInterceptor } from './utils/apiClient.ts';
import { APP_TITLE } from './config/brand.ts';
import './index.css';

installApiFetchInterceptor();
document.title = APP_TITLE;

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
