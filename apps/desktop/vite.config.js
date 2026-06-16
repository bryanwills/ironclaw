import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [sveltekit()],
  clearScreen: false,
  cacheDir: '.vite',
  build: {
    rollupOptions: {
      output: {
        manualChunks(id, { getModuleInfo }) {
          const normalized = id.replaceAll('\\', '/');
          const dynamicImporters = getModuleInfo(id)?.dynamicImporters ?? [];
          const routeChunks = [
            ['src/routes/admin/', 'route-admin'],
            ['src/routes/council/', 'route-council'],
            ['src/routes/dev/playground/', 'route-dev-playground'],
            ['src/routes/extensions/', 'route-extensions'],
            ['src/routes/jobs/', 'route-jobs'],
            ['src/routes/knowledge/', 'route-knowledge'],
            ['src/routes/memory/', 'route-memory'],
            ['src/routes/missions/', 'route-missions'],
            ['src/routes/routines/', 'route-routines'],
            ['src/routes/settings/', 'route-settings'],
            ['src/routes/skills/ironhub/', 'route-skills-ironhub'],
            ['src/routes/skills/', 'route-skills']
          ];
          for (const [routePath, chunkName] of routeChunks) {
            if (
              normalized.includes(routePath) &&
              dynamicImporters.some((importer) =>
                importer.replaceAll('\\', '/').includes(`${routePath}+page.svelte`)
              )
            ) {
              return chunkName;
            }
          }
        }
      }
    }
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**']
    },
    proxy: {
      '/__gw': {
        target: 'http://127.0.0.1:18789',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/__gw/, '')
      }
    }
  }
});
