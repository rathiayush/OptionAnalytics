import { defineConfig } from 'vite'

// The Signal backtest's background job (scanner-runner/signal-backtest.mjs) bundled into one Node file, dist-runner/signal-backtest.mjs - run by
// the server (SignalBacktestJobService) in its own process. No outside dependencies.
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'scanner-runner/signal-backtest.mjs',
    outDir: 'dist-runner',
    emptyOutDir: false,
    target: 'node20',
    minify: false,
    rollupOptions: {
      external: [/^node:/],
      output: { entryFileNames: 'signal-backtest.mjs', format: 'es' },
    },
  },
  ssr: { noExternal: true },
})
