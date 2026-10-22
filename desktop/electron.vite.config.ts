import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// The App Patterns packages are installed from vendored tarballs (file: dependencies), which electron-builder would copy as plain
// files; they are bundled instead. The Settings window is sandboxed, so its preload is one file with the packages inside it.
const BUNDLED = [
  '@app-patterns/commands', '@app-patterns/settings', '@app-patterns/settings-electron', '@app-patterns/settings-react',
  '@app-patterns/updates', '@app-patterns/updates-react',
];

export default defineConfig({
  main: {
    build: { externalizeDeps: { exclude: BUNDLED }, rollupOptions: { input: { index: resolve(__dirname, 'main/index.ts') } } },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: BUNDLED },
      rollupOptions: {
        input: { index: resolve(__dirname, 'preload/index.ts'), settings: resolve(__dirname, 'preload/settings.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'renderer'),
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'renderer/index.html'), settings: resolve(__dirname, 'renderer/settings.html') } },
    },
    plugins: [react()],
  },
});
