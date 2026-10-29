import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    lib: {
      entry: fileURLToPath(new URL('src/index.ts', import.meta.url)),
      name: 'LiquidGlass',
      fileName: 'liquid-glass',
      formats: ['es', 'umd'],
    },
    sourcemap: true,
    minify: 'esbuild',
  },
});
