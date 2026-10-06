// HUD·화면 스크린샷. `npm run dev`를 띄운 상태에서 Node 20+ 로 실행한다.
//   node tools/hudshot.mjs <출력디렉터리> [landscape|portrait|both|WxH] [tag]
//   예) node tools/hudshot.mjs shots both v1
//       node tools/hudshot.mjs shots 1024x768 ipad-small
// 기록 화면(더미 데이터), 코스 선택, 카운트다운, 레이스 HUD(강도 78% → 40%), 5분 피드백(?checkpoint=8), 요약을 찍는다.
// 3D는 ?quality=low 로 돌려 소프트웨어 GL에서도 빨리 끝나게 한다 — HUD 확인용이지 수면 반사 확인용이 아니다.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const [out = 'shots', mode = 'both', tag = 'hud'] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const errs = []

async function shoot(name, viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
  page.on('console', m => { if (m.type() === 'error') errs.push(`${name} ${m.text()}`) })
  page.on('pageerror', e => errs.push(`${name} PAGEERROR: ${e.message}`))
  await page.goto('http://localhost:5173/?weather=seed2&checkpoint=8&quality=low', { waitUntil: 'networkidle' })
  await page.evaluate(() => {
    const mk = (i, name, courseId, dist, done, mins = 30) => ({
      id: `seed-${i}`, at: new Date(Date.UTC(2026, 8, 20 + i, 7, 30)).toISOString(),
      courseId, courseName: name, courseType: '인터벌', venue: 'River Thames, Henley',
      durationSec: mins * 60, baseSplit: 135, elapsed: done ? mins * 60 : Math.round(mins * 60 * 0.52),
      distance: dist, avgSplit: (mins * 60 / dist) * 500, avgSpm: 25 + i, avgPower: 190 + i * 8,
      strokeCount: 700 + i * 20, gap: i % 2 ? 34 : -18, completed: done,
      curve: Array.from({ length: mins * 2 }, (_, k) => ({ t: k * 30, split: 134 + Math.sin(k / 5) * 8 + (k > mins * 1.4 ? -5 : 0) })),
    })
    localStorage.setItem('makeRowing.history.v1', JSON.stringify([
      mk(0, '헨리 인터벌', 'henley-interval-30', 6630, true),
      mk(1, '헨리 스테디', 'henley-steady-30', 6510, true),
      mk(2, '템스 스프린트', 'thames-sprint-20', 4380, true, 20),
      mk(3, '보스반 웨이브', 'bosbaan-wave-40', 3120, false, 40),
    ]))
  })
  await page.reload({ waitUntil: 'networkidle' })
  const shot = step => page.screenshot({ path: `${out}/${tag}-${step}-${name}.png` })
  await page.click('#btn-history'); await page.waitForTimeout(300)
  await page.locator('.hrow').first().click(); await page.waitForTimeout(250)
  await shot('history')
  await page.click('#btn-hist-back')
  await page.click('#btn-sim'); await page.waitForTimeout(300)
  await shot('courses')
  await page.locator('.course', { hasText: '헨리 인터벌' }).first().click()
  await page.click('#btn-start'); await page.waitForTimeout(1500)
  await shot('countdown')
  await page.waitForTimeout(2200)
  const intensity = v => page.locator('#sim-intensity').evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }, v)
  await intensity('78')
  await page.waitForTimeout(9000)
  await shot('race')
  await intensity('40')
  await page.waitForTimeout(3500)
  await shot('race-slow')
  try {
    await page.locator('#feedback.on').waitFor({ timeout: 70000 })
    await page.waitForTimeout(400)
    await shot('feedback')
  } catch { errs.push(`${name} feedback modal did not appear`) }
  await page.click('#btn-quit'); await page.waitForTimeout(400)
  await shot('summary')
  await page.close()
}

const custom = /^(\d+)x(\d+)$/.exec(mode)
if (custom) await shoot(`${custom[1]}x${custom[2]}`, { width: Number(custom[1]), height: Number(custom[2]) })
if (mode === 'both' || mode === 'landscape') await shoot('landscape', { width: 1194, height: 834 })
if (mode === 'both' || mode === 'portrait') await shoot('portrait', { width: 834, height: 1194 })
console.log('errors:', errs.length ? errs.slice(0, 8) : 'none')
await browser.close()
