import { defineConfig } from 'vite'

// The server-side scanner (scanner-runner/) bundled into one Node file, dist-runner/runner.mjs, with the
// shared scanner modules inside it. @microsoft/signalr stays outside: the runner loads it with require()
// so it can find its Node transports (ws, node-fetch ...) in scanner-runner's own node_modules at runtime.
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'scanner-runner/runner.mjs',
    outDir: 'dist-runner',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rollupOptions: {
      external: ['@microsoft/signalr', /^node:/],
      output: { entryFileNames: 'runner.mjs', format: 'es' },
    },
  },
  ssr: { noExternal: true, external: ['@microsoft/signalr'] },
})
