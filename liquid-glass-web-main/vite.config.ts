import { defineConfig } from 'vite';

// `base: './'` emits relative asset URLs so the built demo works when served
// from a project subpath (e.g. GitHub Pages at /<repo>/) as well as at root.
export default defineConfig(({ command }) => ({
  root: '.',
  base: command === 'build' ? './' : '/',
  server: {
    port: 5173,
    host: true,
    open: false,
  },
  build: {
    target: 'es2022',
    outDir: 'dist-demo',
  },
}));
