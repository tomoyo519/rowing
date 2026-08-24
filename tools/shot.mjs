// 3D 화면 시각 확인용. `npm run dev`를 띄운 상태에서 실행한다.
//   node tools/shot.mjs [출력디렉터리]
// Playwright가 Node 20+ 를 요구하므로 nvm 등으로 버전을 올려서 실행할 것.
import { chromium } from 'playwright'

const out = process.argv[2] ?? 'shots'
const BASE = process.env.URL ?? 'http://localhost:5173/'

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 })
const errs = []
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message))

// 기록 화면 확인용 더미 데이터
await page.goto(BASE)
await page.evaluate(() => {
  const mk = (i, name, courseId, dist, done, mins = 30) => ({
    id: `seed-${i}`,
    at: new Date(Date.UTC(2026, 7, 10 + i, 7, 30)).toISOString(),
    courseId, courseName: name, courseType: '인터벌', venue: 'River Thames, Henley',
    durationSec: mins * 60, baseSplit: 145,
    elapsed: done ? mins * 60 : Math.round(mins * 60 * 0.52),
    distance: dist, avgSplit: (1800 / dist) * 500,
    avgSpm: 25 + i, avgPower: 190 + i * 8, strokeCount: 700 + i * 20,
    gap: i % 2 ? 34 : -18, completed: done,
    curve: Array.from({ length: mins }, (_, k) => ({
      t: k * 60, split: 144 + Math.sin(k / 3) * 7 + (k > mins * 0.7 ? -4 : 0),
    })),
  })
  localStorage.setItem('makeRowing.history.v1', JSON.stringify([
    mk(0, '헨리 인터벌', 'henley-interval-30', 6330, true),
    mk(1, '헨리 스테디', 'henley-steady-30', 6210, true),
    mk(2, '템스 스프린트', 'thames-sprint-20', 4180, true, 20),
    mk(3, '보스반 웨이브', 'bosbaan-wave-40', 3020, false, 40),
  ]))
})

// 20초마다 피드백이 뜨도록 해서 모달을 잡는다
await page.goto(BASE + '?checkpoint=20', { waitUntil: 'networkidle' })

await page.click('#btn-history')
await page.waitForTimeout(300)
await page.locator('.hrow').first().click()      // 상세 펼치기
await page.waitForTimeout(250)
await page.screenshot({ path: `${out}/history.png` })
await page.click('#btn-hist-back')

await page.click('#btn-sim')
await page.waitForTimeout(300)
await page.screenshot({ path: `${out}/courses.png`, fullPage: true })

await page.locator('.course', { hasText: '템스 스프린트' }).click()
await page.click('#btn-start')
await page.waitForTimeout(3200)
await page.locator('#sim-intensity').evaluate(el => {
  el.value = '78'; el.dispatchEvent(new Event('input', { bubbles: true }))
})

// 카메라 프리셋 순회
const names = ['front', 'quarter', 'chase', 'side']
for (const name of names) {
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${out}/cam-${name}.png` })
  await page.click('#btn-cam')
  await page.waitForTimeout(250)
}
await page.click('#btn-cam')   // 정면으로 복귀

// 피드백 모달이 뜰 때까지 기다렸다가 캡처
await page.locator('#feedback.on').waitFor({ timeout: 40000 })
await page.waitForTimeout(500)
await page.screenshot({ path: `${out}/feedback.png` })

console.log('errors:', errs.length ? errs.slice(0, 6) : 'none')
await browser.close()
