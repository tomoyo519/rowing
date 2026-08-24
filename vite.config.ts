import { cloudflare } from '@cloudflare/vite-plugin'
import { sites } from '@openai/sites-vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    sites(),
    cloudflare({
      inspectorPort: false,
      config: {
        name: 'server',
        main: './worker/index.js',
        compatibility_date: '2026-08-24',
        assets: {
          binding: 'ASSETS',
          not_found_handling: 'single-page-application',
        },
      },
    }),
  ],
  server: {
    host: true,      // LAN 접속 허용 (터널 없이 테스트할 때)
    port: 5173,
  },
  build: { target: 'es2022' },
})
