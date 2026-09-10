import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// https://vite.dev/config/
export default defineConfig({
  // Issue #60: the ticket portal is natively owned at /tickets on the shared
  // ops origin, so every built asset URL is prefixed with /tickets/.
  base: '/tickets/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      // Canonical API namespace — the Worker normalizes /tickets/api/* -> /api/*.
      '/tickets/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      // Legacy API namespace — retained for local parity with old callers.
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
