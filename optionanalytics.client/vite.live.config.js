import { defineConfig } from 'vite'

// The saved strategies' daily live scan (scanner-runner/signal-live.mjs) bundled into one Node file, dist-runner/signal-live.mjs - run by
// the server (SignalLiveHostedService) in its own process. No outside dependencies.
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'scanner-runner/signal-live.mjs',
    outDir: 'dist-runner',
    emptyOutDir: false,
    target: 'node20',
    minify: false,
    rollupOptions: {
      external: [/^node:/],
      output: { entryFileNames: 'signal-live.mjs', format: 'es' },
    },
  },
  ssr: { noExternal: true },
})
