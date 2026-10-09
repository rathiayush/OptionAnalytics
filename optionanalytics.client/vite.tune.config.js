import { defineConfig } from 'vite'

// The strategy tuning job (scanner-runner/tune.mjs) bundled into one Node file, dist-runner/tune.mjs - run by
// the server (StrategyTuningService) in its own process. No outside dependencies.
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'scanner-runner/tune.mjs',
    outDir: 'dist-runner',
    emptyOutDir: false,
    target: 'node20',
    minify: false,
    rollupOptions: {
      external: [/^node:/],
      output: { entryFileNames: 'tune.mjs', format: 'es' },
    },
  },
  ssr: { noExternal: true },
})
