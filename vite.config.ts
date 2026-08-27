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
    /*
     * Vite는 모르는 Host 헤더로 오는 요청을 기본 차단한다(DNS rebinding 방어).
     * 터널 도메인을 허용하지 않으면 cloudflared/ngrok 주소가 전부 403이 되고,
     * iPad에서 Web Bluetooth를 쓰는 데 필요한 HTTPS 경로가 막힌다.
     */
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.io', '.loca.lt'],
  },
  build: { target: 'es2022' },
})
