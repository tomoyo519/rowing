// 로잉 아바타 클로즈업 스크린샷. `npm run dev`를 띄운 상태에서, tools/shot.mjs처럼 Node 20+ 로 실행한다.
//   node tools/rigshot.mjs <out.png> [fromX fromY fromZ] [fov] [lookDy] [waitMs] [target]
//   예) 머리: node tools/rigshot.mjs shots/head.png 1.7 1.25 1.9 22 -0.12 700 head
//       전신 측면: node tools/rigshot.mjs shots/side.png 0.3 1.3 3.6 30 -0.45 700 shoulder
//       뒤통수·목덜미: node tools/rigshot.mjs shots/hairline.png 0.9 0.55 -1.6 16 -0.05 700 head
// - from*: 플레이어 보트 그룹 기준 카메라 위치(m). 기본 1.7 1.25 1.9 (오른쪽 앞 위에서 내려다봄)
// - fov: 기본 22. lookDy: 머리 관절 기준 시선 y 오프셋(기본 -0.12; 전신은 -0.45 + fov 30 정도)
// - waitMs: 클로즈업 전 대기(스트로크 위상 바꾸기용, 기본 700)
// - target: 'head' | 'shoulder' | 'hip' (어느 관절을 바라볼지, 기본 head)
// 개발 서버(5173)가 떠 있어야 한다. 출력은 640x640으로 잘라낸다.
import { chromium } from 'playwright'

const [out = 'rig.png', fx = '1.7', fy = '1.25', fz = '1.9', fovArg = '22', lookDyArg = '-0.12', waitArg = '700', target = 'head'] = process.argv.slice(2)
const from = [Number(fx), Number(fy), Number(fz)]
const fov = Number(fovArg), lookDy = Number(lookDyArg), waitMs = Number(waitArg)

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 })
const errs = []
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message))
await page.goto('http://localhost:5173/?weather=seed1', { waitUntil: 'networkidle' })
await page.click('#btn-sim'); await page.waitForTimeout(300)
await page.locator('.course', { hasText: '헨리 인터벌' }).first().click()
await page.click('#btn-start'); await page.waitForTimeout(3500)
await page.locator('#sim-intensity').evaluate(el => { el.value = '70'; el.dispatchEvent(new Event('input', { bubbles: true })) })
await page.waitForTimeout(2500)
// 페이스 보트를 멀리 보내 프레이밍이 흔들리지 않게 한다
await page.evaluate(() => { const s = window.__rowing.session; s.paceDistance = s.boat.distance + 300 })
await page.evaluate(([from, fov, lookDy, target]) => {
  const v = window.__rowing.view
  const orig = v.renderer.render.bind(v.renderer)
  v.renderer.render = (scene, cam) => {
    const j = v.player.joints[target] ?? v.player.joints.head
    const g = v.player.group.position
    cam.position.set(g.x + from[0], g.y + from[1], g.z + from[2])
    cam.up.set(0, 1, 0)
    cam.lookAt(g.x + j.x, g.y + j.y + lookDy, g.z + j.z)
    cam.fov = fov; cam.updateProjectionMatrix()
    orig(scene, cam)
  }
}, [from, fov, lookDy, target])
await page.waitForTimeout(waitMs)
await page.screenshot({ path: out, clip: { x: 270, y: 90, width: 640, height: 640 } })
const pose = await page.evaluate(() => window.__rowing.session.stroke.pose())
console.log(JSON.stringify({ out, from, fov, lookDy, target, pose: { slide: pose.slide, bodyAngle: pose.bodyAngle, inWater: pose.inWater } }))
console.log('errors:', errs.length ? errs.slice(0, 4) : 'none')
await browser.close()
