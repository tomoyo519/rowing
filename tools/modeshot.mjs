// 플레이 모드(상어 추격·추월 레이스) 화면 확인용. `npm run dev`를 띄운 상태에서 Node 20+ 로 실행한다.
//   node tools/modeshot.mjs <출력디렉터리> [quality=low|medium|high] [WxH]
//   예) node tools/modeshot.mjs shots low 1194x834
// 상어: 출발 뒤 30m → 14m → 5m(경고) → 물림, 뒤 보기 창. 추월: 라이벌 50m 앞 → 버팀 → 추월. 요약과 기록 꼬리표.
// 상어·라이벌 위치는 window.__rowing(DEV 전용) 훅으로 옮긴다 — 실제 시간으로 기다리면 몇 분씩 걸린다.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const [out = 'shots', quality = 'low', size = '1194x834'] = process.argv.slice(2)
const [vw, vh] = size.split('x').map(Number)
mkdirSync(out, { recursive: true })
const BASE = process.env.URL ?? 'http://localhost:5173/'
// autoplay 허용: 상어 모드 배경 음악(Web Audio)이 실제로 돌아가며 예외를 내지 않는지 콘솔로 확인하기 위해
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
const errs = []
page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)) })
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message))

await page.goto(`${BASE}?weather=seed1&quality=${quality}`, { waitUntil: 'networkidle' })
// 모드 점수가 붙은 더미 기록 — 기록 화면의 꼬리표 확인용
await page.evaluate(() => {
  const mk = (i, name, courseId, dist, mode, score) => ({
    id: `seed-${i}`, at: new Date(Date.UTC(2026, 10, 1 + i, 7, 30)).toISOString(),
    courseId, courseName: name, courseType: '인터벌', venue: 'River Thames, Henley',
    durationSec: 1800, baseSplit: 135, elapsed: 1800, distance: dist, avgSplit: (1800 / dist) * 500,
    avgSpm: 26, avgPower: 200, strokeCount: 780, gap: 20, completed: true,
    curve: Array.from({ length: 30 }, (_, k) => ({ t: k * 60, split: 134 + Math.sin(k / 5) * 8 })),
    ...(mode ? { mode, modeScore: score } : {}),
  })
  localStorage.setItem('makeRowing.history.v1', JSON.stringify([
    mk(0, '헨리 인터벌', 'henley-interval-30', 6630, 'shark', 1),
    mk(1, '헨리 스테디', 'henley-steady-30', 6510, 'chase', 3),
    mk(2, '템스 이지', 'thames-easy-20', 4380, null, 0),
  ]))
})
await page.reload({ waitUntil: 'networkidle' })

const tag = `${quality}-${size}`
const shot = n => page.screenshot({ path: `${out}/mode-${tag}-${n}.png` })
const intensity = v => page.locator('#sim-intensity').evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }, v)
const ev = fn => page.evaluate(fn)
const cycleCamera = () => ev(() => window.__rowing.view.cycleCamera())

await page.click('#btn-history'); await page.waitForTimeout(300)
await shot('history')
await page.click('#btn-hist-back')
await page.click('#btn-sim'); await page.waitForTimeout(300)

// ── 상어 추격 ──
await page.locator('.mode', { hasText: '상어 추격' }).click()
await page.waitForTimeout(200)
await shot('courses')
await page.locator('.course', { hasText: '헨리 인터벌' }).first().click()
await page.click('#btn-start'); await page.waitForTimeout(3800)
await intensity('78')
await page.waitForTimeout(5000)
await shot('shark-30m')
await ev(() => { const s = window.__rowing.session; s.shark.distance = s.boat.distance - 4.5 - 14 })
await page.waitForTimeout(900)
await shot('shark-14m')
await ev(() => { const s = window.__rowing.session; s.shark.distance = s.boat.distance - 4.5 - 5; s.shark.state = 'warn' })
await page.waitForTimeout(700)
await shot('shark-5m-warn')
await cycleCamera(); await page.waitForTimeout(500)
await shot('shark-5m-quarter')
await cycleCamera(); await cycleCamera(); await page.waitForTimeout(500)   // 사이드
await intensity('0')
await ev(() => { const s = window.__rowing.session; s.shark.distance = s.boat.distance - 4.5 - 1 })
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(400)
  if (await ev(() => window.__rowing.session.metrics().shark.caught) > 0) break
}
await page.waitForTimeout(250)
await shot('shark-bite-side')
await cycleCamera(); await page.waitForTimeout(300)   // 추격
await shot('shark-bite-chase')
await page.click('#btn-quit'); await page.waitForTimeout(500)
await shot('shark-summary')

// ── 추월 레이스 ──
await page.click('#btn-again'); await page.waitForTimeout(300)
await page.locator('.mode', { hasText: '추월 레이스' }).click()
await page.waitForTimeout(200)
await page.click('#btn-start'); await page.waitForTimeout(3800)
await intensity('85')
await page.waitForTimeout(6000)
await shot('chase-50m')
await ev(() => { const s = window.__rowing.session; s.rival.distance = s.boat.distance + 12 })
await page.waitForTimeout(1500)
await shot('chase-contest')
await ev(() => { const s = window.__rowing.session; s.rival.distance = s.boat.distance - 7.5 })
await page.waitForTimeout(900)
await shot('chase-overtake')
await cycleCamera(); await page.waitForTimeout(600)
await shot('chase-overtake-quarter')
await page.click('#btn-quit'); await page.waitForTimeout(500)
await shot('chase-summary')

console.log('errors:', errs.length ? errs.slice(0, 8) : 'none')
await browser.close()
