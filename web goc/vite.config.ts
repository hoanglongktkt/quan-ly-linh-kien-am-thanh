import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

const BUILD_ID = process.env.VITE_BUILD_ID || new Date().toISOString().replace(/[:.]/g, '-');

/** File/thư mục không cần HMR — tránh EBUSY trên Windows (zip/rar/temp đang bị khóa). */
const DEV_WATCH_IGNORED = [
  '**/node_modules/**',
  '**/data/**',
  '**/.git/**',
  '**/dist/**',
  '**/*.zip',
  '**/*.rar',
  '**/*.7z',
  '**/*.tar',
  '**/*.gz',
  '**/*.rartemp',
  '**/__rzi_*',
  '**/*.tmp',
  '**/*.temp',
];

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    define: {
      'import.meta.env.VITE_BUILD_ID': JSON.stringify(BUILD_ID),
    },
    envPrefix: ['VITE_'],
    build: {
      // Hash trong tên file — Vite mặc định; giữ rõ ràng để cache-bust khi deploy
      rollupOptions: {
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch:
        process.env.DISABLE_HMR === 'true'
          ? null
          : {
              ignored: DEV_WATCH_IGNORED,
              ...(process.platform === 'win32' ? { usePolling: true, interval: 1000 } : {}),
            },
      strictPort: false,
      allowedHosts: [
        'localhost',
        '127.0.0.1',
        'quanly.linhkienamthanh.net',
        '.linhkienamthanh.net',
      ],
    },
  };
});
