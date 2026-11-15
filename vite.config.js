import { defineConfig } from 'vite';
import mta from './api/mta.js';

// In production /api/mta is a Vercel function; in dev and preview the same handler is mounted here.
const mtaRelay = {
  name: 'mta-relay',
  configureServer(server) { server.middlewares.use('/api/mta', mta); },
  configurePreviewServer(server) { server.middlewares.use('/api/mta', mta); },
};

export default defineConfig({
  base: './',
  plugins: [mtaRelay],
  server: { port: 5191, strictPort: true },
});
