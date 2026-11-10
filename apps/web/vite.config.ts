import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.API_TARGET ?? 'http://localhost:8841';
export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: {
    proxy: {
      '/api': { target: api, changeOrigin: true },
      '/ws': { target: api.replace('http', 'ws'), ws: true },
    },
  },
});
