import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('electron/main.ts'),
          minecraftWorker: resolve('electron/minecraft/workerEntry.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('electron/preload.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve('src'),
    publicDir: resolve('public'),
    resolve: {
      alias: {
        '@framework': resolve('src/framework')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/index.html')
        }
      }
    }
  }
});

