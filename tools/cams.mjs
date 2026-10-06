// 월드(물·하늘·풍경) 품질 확인용 4카메라 2×2 합성 스크린샷. `npm run dev`를 띄운 상태에서 실행한다.
//   node tools/cams.mjs <tag> <weatherSeed> [quality=low|medium|high] [코스 이름]
// 결과는 shots/<tag>-s<seed>[-quality].png. 콘솔 오류·드로우콜·삼각형 수를 함께 찍는다.
// 카메라 전환은 window.__rowing(DEV 전용) 훅으로 하므로 DEV 빌드에서만 동작한다.
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const [tag = 'x', seed = '2', quality = '', courseName = '템스 스프린트'] = process.argv.slice(2)
const BASE = process.env.URL ?? 'http://localhost:5173/'
const query = `?weather=${seed}${quality ? `&quality=${quality}` : ''}`

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1 })
const errs = []
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`${m.type()}: ${m.text().slice(0, 400)}`) })
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message))

await page.goto(BASE + query, { waitUntil: 'networkidle' })
await page.click('#btn-sim')
await page.waitForTimeout(300)
await page.locator('.course', { hasText: courseName }).click()
await page.click('#btn-start')
await page.waitForTimeout(3500)
await page.locator('#sim-intensity').evaluate(el => {
  el.value = '78'; el.dispatchEvent(new Event('input', { bubbles: true }))
})
await page.waitForTimeout(6000)
await page.addStyleTag({ content: '#screen-race .hud, #screen-race .topbar, #screen-race button { visibility: hidden !important; }' })

const shots = []
const names = ['chase', 'quarter', 'front', 'side']
const info = []
for (const name of names) {
  await page.waitForTimeout(900)
  const buf = await page.screenshot({ type: 'png' })
  shots.push(buf.toString('base64'))
  info.push(await page.evaluate(() => {
    const r = window.__rowing
    const v = r?.view
    const i = v?.renderer?.info?.render
    return { tier: v?.qualityTier, calls: i?.calls, tris: i?.triangles, cam: v?.cameraName, dist: Math.round(r?.session?.boat?.distance ?? 0) }
  }))
  await page.evaluate(() => window.__rowing.view.cycleCamera())
  await page.waitForTimeout(250)
}

// 2×2 합성
const comp = await browser.newPage({ viewport: { width: 1920, height: 1200 }, deviceScaleFactor: 1 })
await comp.setContent(`<body style="margin:0;background:#000"><canvas id=c width=1920 height=1200></canvas></body>`)
await comp.evaluate(async (shots) => {
  const ctx = document.getElementById('c').getContext('2d')
  for (let i = 0; i < shots.length; i++) {
    const img = new Image()
    img.src = 'data:image/png;base64,' + shots[i]
    await img.decode()
    ctx.drawImage(img, (i % 2) * 960, Math.floor(i / 2) * 600)
  }
}, shots)
const out = `${process.env.OUT ?? 'shots'}/${tag}-s${seed}${quality ? '-' + quality : ''}.png`
writeFileSync(out, await comp.locator('#c').screenshot({ type: 'png' }))
console.log('saved', out)
console.log('info', JSON.stringify(info))
console.log('errors', errs.length ? '\n' + [...new Set(errs)].slice(0, 12).join('\n') : 'none')
await browser.close()
