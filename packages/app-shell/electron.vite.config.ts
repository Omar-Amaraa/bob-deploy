import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      rollupOptions: { input: resolve(import.meta.dirname, 'src/main/index.ts') },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      externalizeDeps: false,
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/preload/index.ts'),
        output: {
          entryFileNames: '[name].cjs',
          format: 'cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, '../ui'),
    build: {
      outDir: 'dist/renderer',
      rollupOptions: { input: resolve(import.meta.dirname, '../ui/index.html') },
    },
  },
});
