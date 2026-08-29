import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The backend (OptionAnalytics.Server) is expected to run on http://localhost:5080 in dev - see
// its Properties/launchSettings.json. '/api' and '/hubs' are proxied so the client can use plain
// relative paths in both dev and the production build (where the built app is served from the
// backend's own wwwroot, so those same paths resolve without a proxy at all).
const backendUrl = process.env.BACKEND_URL || 'http://localhost:5080'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '^/api': { target: backendUrl, changeOrigin: true },
      '^/hubs': { target: backendUrl, changeOrigin: true, ws: true },
    },
  },
})
