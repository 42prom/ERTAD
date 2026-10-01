import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', 'ERTAD_');
  const target = `http://127.0.0.1:${env.ERTAD_API_PORT || 13000}`;
  return { plugins: [react()], server: {
    host: '127.0.0.1', port: Number(env.ERTAD_WEB_PORT || 15173), strictPort: true,
    proxy: { '/api': target, '/health': target },
  } };
});
