import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API = process.env.VITE_API_PROXY || 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Remotion composition shared with the server-side renderer
      '@composition': path.resolve(__dirname, '../video-renderer/src/composition'),
    },
    // the composition lives outside this package — make it use our React/Remotion
    dedupe: ['react', 'react-dom', 'remotion'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/encryption': { target: API, changeOrigin: true },
      '/socket.io': { target: API, ws: true, changeOrigin: true },
    },
    fs: { allow: ['..'] },
  },
});
