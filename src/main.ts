import { FtmsSource } from './ble/connection'
import { MockSource } from './sim/mockRower'
import {
  COURSES, PACE_TIERS, courseGroups, projectedDistance, courseRangeLabel,
  type Course, type PaceTier,
} from './game/courses'
import { profileSamples } from './game/profile'
import { Session } from './game/state'
import { buildFeedback } from './game/feedback'
import { saveRecord, thinCurve, type SessionRecord } from './game/history'
import { FeedbackModal } from './ui/feedbackModal'
import { renderHistory } from './ui/historyScreen'
import { View } from './three/view'
import { formatSplit, formatSplitShort, formatClock } from './game/physics'
import type { RowerSource } from './types'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const show = (id: string) => {
  for (const s of document.querySelectorAll('.screen')) s.classList.remove('active')
  $(id).classList.add('active')
}

let source: RowerSource | null = null
let session: Session | null = null
let view: View | null = null
let selectedCourse: Course = COURSES[0]!
let selectedTier: PaceTier = PACE_TIERS[1]!
let wakeLock: WakeLockSentinel | null = null

// ── 연결 화면 ───────────────────────────────────────────────
const note = $('connect-note')
if (!navigator.bluetooth) {
  note.innerHTML = '이 브라우저는 Web Bluetooth를 지원하지 않습니다.<br>' +
    'iPad에서는 <b>Bluefy</b> 브라우저로 이 주소를 열어주세요. ' +
    '데스크톱은 Chrome/Edge를 쓰면 됩니다.<br>시뮬레이터는 어디서든 동작합니다.'
} else if (!window.isSecureContext) {
  note.innerHTML = '현재 <b>HTTPS가 아닙니다.</b> Web Bluetooth는 secure context에서만 동작합니다.<br>' +
    '<code>npm run tunnel</code>로 HTTPS 주소를 만들어 접속하세요.'
} else {
  note.innerHTML = '로잉머신 전원을 켜고 다른 앱과의 블루투스 연결을 먼저 해제하세요. ' +
    'FTMS 기기는 보통 한 번에 한 대만 연결됩니다.'
}

$('btn-ble').addEventListener('click', async () => {
  const err = $('connect-err')
  err.textContent = ''
  const src = new FtmsSource()
  src.onStatus((s, d) => {
    if (s === 'error') err.textContent = d ?? '연결에 실패했습니다'
    if (s === 'disconnected') err.textContent = '로잉머신 연결이 끊어졌습니다'
  })
  try {
    await src.connect()
    source = src
    $('simctl').classList.remove('on')
    goCourseSelect()
  } catch { /* onStatus가 이미 표시함 */ }
})

$('btn-sim').addEventListener('click', async () => {
  const src = new MockSource()
  await src.connect()
  source = src
  $('simctl').classList.add('on')
  goCourseSelect()
})

// ── 코스 선택 ───────────────────────────────────────────────
function goCourseSelect() {
  renderTiers()
  renderCourses()
  show('screen-course')
}

function renderTiers() {
  const el = $('tiers')
  el.innerHTML = ''
  for (const t of PACE_TIERS) {
    const b = document.createElement('button')
    b.className = 'tier' + (t.id === selectedTier.id ? ' sel' : '')
    b.innerHTML = `<b>${t.label}</b><span>${formatSplitShort(t.split)}</span>`
    b.addEventListener('click', () => { selectedTier = t; renderTiers(); renderCourses() })
    el.appendChild(b)
  }
  $('tier-hint').textContent = selectedTier.hint
}

/** 코스 강도 프로파일을 미니 그래프(SVG)로 */
function sparkline(c: Course): string {
  const s = profileSamples(c.profile, c.durationSec, 72)
  const W = 100, H = 26
  const pts = s.map((v, i) => `${(i / (s.length - 1)) * W},${H - 3 - v * (H - 6)}`).join(' ')
  const area = `0,${H} ${pts} ${W},${H}`
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <polygon points="${area}" class="spark-fill" />
    <polyline points="${pts}" class="spark-line" />
  </svg>`
}

function renderCourses() {
  const el = $('courses')
  el.innerHTML = ''
  for (const group of courseGroups()) {
    const h = document.createElement('div')
    h.className = `group-head ${group.tone}`
    h.textContent = group.label
    el.appendChild(h)

    const note = document.createElement('div')
    note.className = 'group-note'
    note.textContent = group.note
    el.appendChild(note)

    const grid = document.createElement('div')
    grid.className = 'course-grid'
    for (const c of group.courses) {
      const dist = projectedDistance(c, selectedTier.split)
      const b = document.createElement('button')
      b.className = 'course' + (c.id === selectedCourse.id ? ' sel' : '')
      b.innerHTML = `
        <div class="chead">
          <div>
            <div class="nm">${c.name}</div>
            <div class="loc">${c.venue.location}</div>
          </div>
          <div class="ctags">
            <div class="dur">${Math.round(c.durationSec / 60)}분</div>
            <div class="tag">${c.type}</div>
          </div>
        </div>
        ${sparkline(c)}
        <div class="range">페이스 ${courseRangeLabel(c)}</div>
        <div class="desc">${c.description}</div>
        <div class="est">
          <b>${(dist / 1000).toFixed(2)} km</b>
          <span>${selectedTier.label} 기준 예상</span>
        </div>`
      b.addEventListener('click', () => { selectedCourse = c; renderCourses() })
      grid.appendChild(b)
    }
    el.appendChild(grid)
  }
}

$('btn-back').addEventListener('click', async () => {
  await source?.disconnect()
  source = null
  show('screen-connect')
})

$('btn-start').addEventListener('click', () => startRace())

// ── 기록 화면 ───────────────────────────────────────────────
function goHistory(back: () => void) {
  renderHistory(back)
  show('screen-history')
}
$('btn-history').addEventListener('click', () => goHistory(() => show('screen-connect')))
$('btn-history-2').addEventListener('click', () => goHistory(() => show('screen-course')))
$('btn-sum-history').addEventListener('click', () => goHistory(() => show('screen-summary')))

// ── 레이스 ──────────────────────────────────────────────────
const cv = $<HTMLCanvasElement>('cv')
let unsub: (() => void) | null = null
const feedbackModal = new FeedbackModal()

/**
 * 피드백 주기 (초). 기본 5분.
 * 개발 중에는 `?checkpoint=20` 처럼 붙여서 짧게 돌려볼 수 있다.
 */
const CHECKPOINT = (() => {
  const q = Number(new URLSearchParams(location.search).get('checkpoint'))
  return q > 0 ? q : 5 * 60
})()
/** 남은 시간이 이보다 적으면 띄우지 않는다 — 곧 요약이 나온다 */
const MIN_TAIL = 45
let lastCheckpoint = 0

window.addEventListener('resize', () => view?.resize())
window.addEventListener('orientationchange', () => setTimeout(() => view?.resize(), 150))

async function startRace() {
  if (!source) return
  session = new Session(selectedCourse, selectedTier.split)
  unsub?.()
  unsub = source.onSample(s => session?.onSample(s))

  lastCheckpoint = 0
  feedbackModal.reset()
  show('screen-race')
  view?.dispose()
  view = new View(cv, session)
  view.resize()
  await requestWakeLock()

  const cd = $('countdown')
  cd.style.display = 'flex'
  for (const n of ['3', '2', '1', 'ROW']) {
    cd.textContent = n
    await sleep(700)
  }
  cd.style.display = 'none'
  session.start()
}

$('btn-quit').addEventListener('click', () => { session?.finish(); showSummary() })

let camToastAt = 0
$('btn-cam').addEventListener('click', () => {
  if (!view) return
  const name = view.cycleCamera()
  const t = $('cam-toast')
  t.textContent = name
  t.style.opacity = '1'
  camToastAt = performance.now()
  setTimeout(() => { if (performance.now() - camToastAt >= 1400) t.style.opacity = '0' }, 1500)
})
$('sim-intensity').addEventListener('input', e => {
  if (source instanceof MockSource) {
    source.intensity = Number((e.target as HTMLInputElement).value) / 100
  }
})

// ── 렌더 루프 ───────────────────────────────────────────────
let last = performance.now()
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now

  if (session && view && $('screen-race').classList.contains('active')) {
    session.update(dt)
    view.render(session, now / 1000, dt)
    updateHud()
    checkFeedback()
    if (session.phase === 'finished') showSummary()
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

/** 5분마다 최근 구간을 평가해서 모달을 띄운다 */
function checkFeedback() {
  if (!session || session.phase !== 'running') return
  const elapsed = session.elapsed
  const due = lastCheckpoint + CHECKPOINT
  if (elapsed < due) return
  lastCheckpoint = due

  // 코스가 곧 끝나면 건너뛴다
  if (session.course.durationSec - elapsed < MIN_TAIL) return

  const w = session.windowStats(due - CHECKPOINT, due)
  if (!w) return

  const idx = Math.round(due / CHECKPOINT) - 1
  // 다음 구간이 이번 구간과 다르면 예고해준다
  const now = session.metrics().step.label
  const soon = session.stepLabelAt(elapsed + 60)
  feedbackModal.show(buildFeedback(w, session.metrics().gap, idx, soon !== now ? soon : undefined))
}

let lmShownAt = -1
function updateHud() {
  if (!session || !view) return
  const m = session.metrics()

  $('s-split').textContent = formatSplit(m.split)
  $('s-target').textContent = formatSplit(m.targetSplit)
  $('s-dist').innerHTML = `${Math.round(m.distance)}<span class="u">m</span>`
  $('s-time').textContent = formatClock(m.remaining)
  $('s-spm').textContent = String(Math.round(m.spm))
  $('s-pow').innerHTML = `${Math.round(m.power)}<span class="u">W</span>`

  // 목표 대비 얼마나 벗어났는지 색으로
  const off = m.split - m.targetSplit
  $('s-split').className = 'v ' + (off < -1.5 ? 'fast' : off > 1.5 ? 'slow' : '')

  // 현재 구간
  const seg = $('segment')
  seg.querySelector('.seg-label')!.textContent = m.step.label
  const rem = seg.querySelector('.seg-rem') as HTMLElement
  rem.textContent = m.step.remaining !== null ? formatClock(m.step.remaining) : ''
  seg.classList.toggle('hard', m.intensity > 1.03)
  seg.classList.toggle('easy', m.intensity < 0.97)

  const gap = $('s-gap')
  const g = Math.round(m.gap)
  gap.textContent = `${g >= 0 ? '+' : ''}${g}m`
  gap.className = 'g ' + (g >= 0 ? 'ahead' : 'behind')
  $('s-prog').style.width = `${m.progress * 100}%`

  // 랜드마크 이름 — 지나갈 때만 잠깐
  const lm = view.nearestLandmark(session)
  const el = $('landmark')
  if (lm && Math.abs(lm.dist) < 70) {
    el.textContent = lm.name
    el.style.opacity = String(Math.max(0, 1 - Math.abs(lm.dist) / 70))
    lmShownAt = m.elapsed
  } else if (m.elapsed - lmShownAt > 0.5) {
    el.style.opacity = '0'
  }
}

// ── 요약 ────────────────────────────────────────────────────
function showSummary() {
  if (!session) return
  const m = session.metrics()
  const s = session
  session = null
  unsub?.(); unsub = null
  view?.dispose(); view = null
  feedbackModal.reset()
  releaseWakeLock()

  $('sum-title').textContent = m.progress >= 0.999 ? '코스 완주' : '세션 종료'

  const beat = m.gap >= 0
  $('sum-verdict').innerHTML = beat
    ? `<b>${s.course.name}</b>에서 페이스 보트를 <b>${Math.round(m.gap)}m</b> 앞섰습니다.`
    : `<b>${s.course.name}</b>에서 페이스 보트에 <b>${Math.abs(Math.round(m.gap))}m</b> 뒤졌습니다.`

  const n = s.track.length
  const avgSpm = n ? s.track.reduce((a, x) => a + x.spm, 0) / n : 0
  const avgPow = n ? s.track.reduce((a, x) => a + x.power, 0) / n : 0

  // 아주 짧게 끝난 세션은 기록으로 남기지 않는다 (실수로 시작한 경우)
  if (m.elapsed >= 60 && m.distance > 50) {
    const rec: SessionRecord = {
      id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      at: new Date().toISOString(),
      courseId: s.course.id,
      courseName: s.course.name,
      courseType: s.course.type,
      venue: s.course.venue.location,
      durationSec: s.course.durationSec,
      baseSplit: s.baseSplit,
      elapsed: m.elapsed,
      distance: m.distance,
      avgSplit: m.avgSplit,
      avgSpm,
      avgPower: avgPow,
      strokeCount: m.strokeCount,
      gap: m.gap,
      completed: m.progress >= 0.999,
      curve: thinCurve(s.track),
    }
    saveRecord(rec)
  }

  const cells: [string, string][] = [
    ['거리', `${(m.distance / 1000).toFixed(2)}<span>km</span>`],
    ['시간', formatClock(m.elapsed)],
    ['평균 스플릿', formatSplit(m.avgSplit)],
    ['평균 SPM', avgSpm.toFixed(1)],
    ['평균 파워', `${Math.round(avgPow)}<span>W</span>`],
    ['스트로크', String(m.strokeCount)],
  ]
  $('sumgrid').innerHTML = cells
    .map(([k, v]) => `<div class="sumcell"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('')

  show('screen-summary')
}

$('btn-again').addEventListener('click', () => goCourseSelect())

// ── 화면 꺼짐 방지 ──────────────────────────────────────────
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen') ?? null } catch { /* 미지원 */ }
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {})
  wakeLock = null
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && $('screen-race').classList.contains('active')) {
    requestWakeLock()
  }
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
