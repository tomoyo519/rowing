import { cloudflare } from '@cloudflare/vite-plugin'
import { sites } from '@openai/sites-vite-plugin'
import { defineConfig } from 'vite'
import { execSync } from 'node:child_process'

/**
 * 빌드 식별자: 커밋 짧은 해시 + 빌드 일시(KST). 화면 구석과 연결 로그에 찍어 "반영 안 됨" 보고 때
 * 어떤 빌드가 떠 있는지 바로 알 수 있게 한다. Vercel은 얕은 clone이라 환경변수를 먼저 본다.
 */
function buildStamp(): string {
  let sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7)
  if (!sha) {
    try { sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { sha = 'local' }
  }
  const at = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16)
  return `${sha} ${at}`
}

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
  define: { __BUILD__: JSON.stringify(buildStamp()) },
})
