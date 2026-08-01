import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';

const suppressElectronPlatformWarning = (warning: any, warn: (warning: any) => void) => {
  if (String(warning?.message || '').includes('Unknown input options: platform')) return;
  warn(warning);
};

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron-store', 'ssh2', 'pdf-parse', 'node-pty'],
              onwarn: suppressElectronPlatformWarning,
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(args) {
          args.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              onwarn: suppressElectronPlatformWarning,
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/react-markdown|remark-|rehype-|micromark|mdast-|hast-|unified|unist-|vfile/.test(id)) return 'markdown';
          if (id.includes('lucide-react')) return 'iconen';
          if (/node_modules[\\/]react(?:-dom)?[\\/]/.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
});
