import { FtmsSource, type BleDiagnosticEntry, type BleScanMode } from './ble/connection'
import { MockSource } from './sim/mockRower'
import {
  COURSES, PACE_TIERS, courseGroups, projectedDistance, courseRangeLabel,
  type Course, type PaceTier,
} from './game/courses'
import { profileSamples } from './game/profile'
import { paceGaugeState } from './game/paceGauge'
import { Session, type Phase, type StallReason } from './game/state'
import { buildFeedback } from './game/feedback'
import { saveRecord, thinCurve, personalBest, type SessionRecord } from './game/history'
import { FeedbackModal } from './ui/feedbackModal'
import { renderHistory } from './ui/historyScreen'
import { View } from './three/view'
import type { RigBody } from './three/rig'
import { formatSplit, formatSplitShort, formatClock } from './game/physics'
import { RowingMetronome } from './audio/metronome'
import { AudioCues } from './audio/cues'
import { AMBIENT_AUDIO_ATTRIBUTION_URL, AmbientSoundscape } from './audio/ambience'
import { loadGhost } from './game/ghost'
import {
  createCoursePath,
  localPathPoint,
  PACE_LANE_OFFSET,
  PLAYER_LANE_OFFSET,
  type CoursePath,
} from './game/coursePath'
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
/** 아바타 체형. 이 브라우저에 저장되어 다음에도 유지된다 */
const AVATAR_KEY = 'makeRowing.avatar.v1'
const AVATARS: { id: RigBody; label: string; hint: string }[] = [
  { id: 'female', label: '여자', hint: '뒤로 묶은 머리' },
  { id: 'male', label: '남자', hint: '모자' },
]
let avatarBody: RigBody = loadAvatarBody()

function loadAvatarBody(): RigBody {
  try { return localStorage.getItem(AVATAR_KEY) === 'female' ? 'female' : 'male' } catch { return 'male' }
}
function saveAvatarBody(body: RigBody) {
  try { localStorage.setItem(AVATAR_KEY, body) } catch { /* 저장소 미지원 — 이번 세션만 유지 */ }
}
let wakeLock: WakeLockSentinel | null = null
/** 늦게 끝난 화면 잠금 요청이 종료된 레이스의 잠금을 되살리지 않게 하는 세대 번호 */
let wakeLockGeneration = 0

// Bluetooth 진단은 화면을 이동해도 남아 있어, 나중에 복사해서 확인할 수 있다.
const bleLog: BleDiagnosticEntry[] = []
const BLE_LOG_LIMIT = 120

function appendBleLog(entry: BleDiagnosticEntry) {
  bleLog.push(entry)
  if (bleLog.length > BLE_LOG_LIMIT) bleLog.shift()

  const panel = $('ble-log-panel')
  const open = $('btn-log-open')
  open.hidden = false
  $('ble-log-count').textContent = String(bleLog.length)
  if ($('screen-connect').classList.contains('active') || entry.level === 'warning' || entry.level === 'error') {
    panel.hidden = false
  }
  const list = $('ble-log-list')
  const item = document.createElement('li')
  item.className = `ble-entry ${entry.level}`

  const meta = document.createElement('div')
  meta.className = 'ble-entry-meta'
  const time = document.createElement('time')
  time.textContent = new Date(entry.at).toLocaleTimeString('ko-KR', { hour12: false })
  const code = document.createElement('code')
  code.textContent = entry.errorName ? `${entry.code} · ${entry.errorName}` : entry.code
  meta.append(time, code)

  const message = document.createElement('div')
  message.className = 'ble-entry-msg'
  message.textContent = entry.message
  item.append(meta, message)
  if (entry.detail) {
    const detail = document.createElement('div')
    detail.className = 'ble-entry-detail'
    detail.textContent = entry.detail
    item.append(detail)
  }
  list.append(item)
  while (list.children.length > BLE_LOG_LIMIT) list.firstElementChild?.remove()
  list.scrollTop = list.scrollHeight
  $('ble-log-state').textContent = entry.message
}

function bleLogText() {
  return bleLog.map(entry => {
    const at = new Date(entry.at).toISOString()
    const error = entry.errorName ? ` ${entry.errorName}` : ''
    const detail = entry.detail ? `\n  ${entry.detail}` : ''
    return `[${at}] ${entry.level.toUpperCase()} ${entry.code}${error}\n  ${entry.message}${detail}`
  }).join('\n')
}

$('btn-log-copy').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('btn-log-copy')
  try {
    await navigator.clipboard.writeText(bleLogText())
    button.textContent = '복사됨'
  } catch {
    button.textContent = '복사 실패'
  }
  window.setTimeout(() => { button.textContent = '복사' }, 1_400)
})

$('btn-log-clear').addEventListener('click', () => {
  bleLog.length = 0
  $('ble-log-list').replaceChildren()
  $('ble-log-state').textContent = '로그를 지웠습니다'
  $('ble-log-count').textContent = '0'
  $('btn-log-open').hidden = true
})

$('btn-log-open').addEventListener('click', () => { $('ble-log-panel').hidden = false })
$('btn-log-close').addEventListener('click', () => { $('ble-log-panel').hidden = true })

// ── 연결 화면 ───────────────────────────────────────────────
const note = $('connect-note')
const isIPad = /iPad/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
if (!navigator.bluetooth) {
  note.innerHTML = '이 브라우저는 Web Bluetooth를 지원하지 않습니다.<br>' +
    'iPad에서는 <b>Bluefy 앱을 먼저 열고, Bluefy 주소창에 이 사이트 주소를 직접 입력</b>하세요. ' +
    'Safari나 ChatGPT 안에서 연 링크로는 기기 선택창이 뜨지 않습니다.<br>' +
    '데스크톱은 Chrome/Edge를 쓰면 됩니다.<br>시뮬레이터는 어디서든 동작합니다.'
} else if (!window.isSecureContext) {
  note.innerHTML = '현재 <b>HTTPS가 아닙니다.</b> Web Bluetooth는 secure context에서만 동작합니다.<br>' +
    '<code>npm run tunnel</code>로 HTTPS 주소를 만들어 접속하세요.'
} else {
  note.innerHTML = (isIPad
    ? '<b>정상 동작:</b> 연결 버튼을 누르면 주변 Bluetooth 기기 선택창이 떠야 합니다.<br>' +
      'Bluefy 주소창에서 직접 연 뒤, iPad 설정 → 개인정보 보호 및 보안 → Bluetooth에서 Bluefy 권한을 허용하세요.<br>'
    : '') +
    '로잉머신 전원을 켜고 다른 앱과의 블루투스 연결을 먼저 해제하세요. ' +
    '목록에 로잉머신이 없으면 <b>주변 Bluetooth 기기 전체 보기</b>를 눌러보세요.'
}
const audioCredits = document.createElement('a')
audioCredits.href = AMBIENT_AUDIO_ATTRIBUTION_URL
audioCredits.target = '_blank'
audioCredits.rel = 'noopener'
audioCredits.textContent = '주변음 출처 및 라이선스'
note.append(document.createElement('br'), audioCredits)

async function connectBle(scanMode: BleScanMode) {
  const err = $('connect-err')
  const primary = $<HTMLButtonElement>('btn-ble')
  const allDevices = $<HTMLButtonElement>('btn-ble-all')
  const button = scanMode === 'all' ? allDevices : primary
  const originalLabel = button.textContent ?? '로잉머신 연결'
  err.textContent = ''
  $('ble-log-panel').hidden = false
  primary.disabled = true
  allDevices.disabled = true
  button.textContent = '연결 확인 중…'
  const src = new FtmsSource()
  src.onDiagnostic(appendBleLog)
  src.onStatus((s, d) => {
    if (s === 'error') {
      err.textContent = d ?? '연결에 실패했습니다'
      $('ble-log-panel').hidden = false   // 실패했으면 로그를 다시 펼쳐 원인을 보여준다
    }
    // 자동 재연결이 생기면서 예기치 않은 끊김은 'disconnected'가 아니라 'reconnecting'으로 온다.
    // 이걸 안 잡으면 연결이 끊겨도 화면에 아무것도 안 뜬다.
    if (s === 'reconnecting') {
      err.textContent = '연결이 끊어져 다시 연결하는 중입니다…'
      $('ble-log-panel').hidden = false
      if ($('screen-race').classList.contains('active')) {
        const alert = $('ble-race-alert')
        alert.textContent = '로잉머신 연결이 끊어졌습니다. 자동으로 다시 연결하는 중입니다.'
        alert.classList.add('on')
      }
    }
    if (s === 'connected') {
      err.textContent = ''
      $('ble-race-alert').classList.remove('on')
    }
    if (s === 'disconnected') {
      err.textContent = '로잉머신 연결이 끊어졌습니다'
      if ($('screen-race').classList.contains('active')) {
        const alert = $('ble-race-alert')
        alert.textContent = '로잉머신 연결이 끊어졌습니다. 연결 화면의 진단 로그에서 원인을 확인할 수 있습니다.'
        alert.classList.add('on')
      }
    }
  })
  try {
    await src.connect(scanMode)
    source = src
    $('simctl').classList.remove('on')
    $('ble-log-panel').hidden = true
    goCourseSelect()
  } catch (error) {
    if (scanMode === 'ftms' && error instanceof DOMException && error.name === 'NotFoundError') {
      err.textContent = 'FTMS 목록에서 찾지 못했습니다. 아래 “주변 Bluetooth 기기 전체 보기”로 다시 시도하세요.'
    }
  }
  finally {
    primary.disabled = false
    allDevices.disabled = false
    button.textContent = originalLabel
  }
}

// iPad/Bluefy는 광고 필터 호환성 차이가 있어 처음부터 전체 선택창을 여는 편이 안정적이다.
$('btn-ble').addEventListener('click', () => void connectBle(isIPad ? 'all' : 'ftms'))
$('btn-ble-all').addEventListener('click', () => void connectBle('all'))

$('btn-sim').addEventListener('click', async () => {
  const src = new MockSource()
  await src.connect()
  source = src
  $('simctl').classList.add('on')
  goCourseSelect()
})

// ── 코스 선택 ───────────────────────────────────────────────
function goCourseSelect() {
  renderAvatars()
  renderTiers()
  renderCourses()
  show('screen-course')
}

function renderAvatars() {
  const el = $('avatars')
  el.innerHTML = ''
  for (const a of AVATARS) {
    const b = document.createElement('button')
    b.className = 'tier avatar' + (a.id === avatarBody ? ' sel' : '')
    b.setAttribute('aria-pressed', String(a.id === avatarBody))
    b.innerHTML = `<b>${a.label}</b><span>${a.hint}</span>`
    b.addEventListener('click', () => { avatarBody = a.id; saveAvatarBody(a.id); renderAvatars() })
    el.appendChild(b)
  }
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

/** 이 코스에 지난 기록이 있으면 카드에 보여준다 — 고스트가 나온다는 신호이기도 하다 */
function pbLine(c: Course): string {
  const pb = personalBest(c.id)
  if (!pb) return ''
  return `<div class="pb">내 최고 ${(pb.distance / 1000).toFixed(2)} km · ${formatSplitShort(pb.avgSplit)}/500m</div>`
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
        ${pbLine(c)}
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
const metronome = new RowingMetronome()
const cues = new AudioCues(metronome)
const ambience = new AmbientSoundscape(metronome)
let racePath: CoursePath = createCoursePath(selectedCourse.id)
let raceTotal = 1
let lastMiniMapAt = -1

function syncSoundButton() {
  const button = $<HTMLButtonElement>('btn-sound')
  button.textContent = metronome.isMuted ? '×♪' : '♪'
  button.setAttribute('aria-pressed', String(metronome.isMuted))
  button.title = metronome.isMuted ? '모든 운동 소리 켜기' : '모든 운동 소리 끄기'
  button.setAttribute('aria-label', button.title)
}
syncSoundButton()

$('btn-sound').addEventListener('click', () => {
  if (metronome.toggleMuted()) cues.stopSpeech()
  syncSoundButton()
})

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
let unsubStatus: (() => void) | null = null
/** 구간이 바뀔 때만 소리를 내기 위한 직전 구간 이름 */
let lastStepLabel: string | null = null
/** 끊김 배너를 원인까지 바뀔 때 갱신하기 위한 직전 값 */
let lastStallReason: StallReason = null
/** 구간 전환이 강해지는 방향인지 판단하기 위한 직전 강도 */
let lastStepIntensity = 1
/** 출발 대기 → 출발 전환을 잡기 위한 직전 세션 상태 */
let lastPhase: Phase | null = null

window.addEventListener('resize', () => view?.resize())
window.addEventListener('orientationchange', () => setTimeout(() => view?.resize(), 150))

async function startRace() {
  if (!source) return
  // 첫 await 전에 호출되어야 iPad가 Web Audio를 사용자 제스처로 인정한다.
  void metronome.unlock()
  cues.primeSpeech()
  metronome.stop()
  const ghost = loadGhost(selectedCourse.id)
  // 개발 중에는 `?weather=seed`로 날씨 일정을 고정해 같은 하늘을 다시 볼 수 있다.
  const weatherSeed = new URLSearchParams(location.search).get('weather')
  session = new Session(selectedCourse, selectedTier.split, ghost, weatherSeed ? `${selectedCourse.id}:${weatherSeed}` : undefined)
  ambience.reset(`${session.weatherSeed}:ambience`)
  void ambience.prepare()
  unsub?.()
  unsub = source.onSample(s => session?.onSample(s))

  // 레이스 중 연결 상태를 세션에 그대로 물려준다 — 끊기면 시계가 멈춘다
  unsubStatus?.()
  unsubStatus = source.onStatus(st => {
    session?.setLinkDown(st !== 'connected')
  })
  // onStatus는 다음 변화부터 알려주므로 현재 상태도 즉시 반영한다.
  session.setLinkDown(source.status !== 'connected')

  $('ghost-gap').classList.toggle('on', ghost !== null)
  lastStepLabel = null
  lastStallReason = null
  lastCheckpoint = 0
  feedbackModal.reset()
  $('ble-race-alert').classList.remove('on')
  racePath = createCoursePath(selectedCourse.id)
  raceTotal = projectedDistance(selectedCourse, selectedTier.split)
  lastMiniMapAt = -1
  renderRaceProfile()
  show('screen-race')
  view?.dispose()
  view = new View(cv, session, avatarBody)
  view.resize()
  if (import.meta.env.DEV) (window as unknown as { __rowing: unknown }).__rowing = { session, view }

  // 화면 잠금 요청이 늦게 끝나는 동안에도 ✕로 나갈 수 있다. await 전에 이 세션을 잡아 둬야
  // 종료된 화면 위에 카운트다운을 띄우거나 null 세션을 건드리지 않는다.
  const mine = session
  const generation = ++countdownGeneration
  const cancelled = () => session !== mine || mine.phase === 'finished' || generation !== countdownGeneration
  await requestWakeLock()
  if (cancelled()) return

  // 카운트다운 중에 ✕로 나가거나 다른 코스를 다시 시작할 수 있다 — 그 세션은 여기서 건드리면 안 된다
  await runCountdown(generation)
  if (cancelled()) return
  // 카운트다운이 끝나도 사용자가 젓기 전엔 아무도 출발하지 않는다
  mine.arm()
  lastPhase = mine.phase
  // 이미 젓는 중이라 바로 출발했다면 오버레이가 "노를 저으면"이라고 우기면 안 된다
  if (mine.phase === 'running') $('cd-sub').textContent = ''
}

/**
 * 시작 카운트다운.
 *
 * 화면이 뜨자마자 숫자가 넘어가면 손잡이 잡을 틈이 없다. '준비'를 먼저 잠깐 보여준 뒤
 * 3·2·1을 각각 1초씩 세고, '시작'이 뜨는 순간 세션이 시작된다.
 * '시작' 글자는 세션을 막지 않고 잠깐 남았다가 사라진다.
 */
const COUNTDOWN_READY_MS = 1100
const COUNTDOWN_STEP_MS = 1000
const COUNTDOWN_GO_MS = 550
/** 진행 중인 카운트다운의 세대. 새 카운트다운이 시작되거나 운동이 끝나면 올라가고, 옛 것은 멈춘다. */
let countdownGeneration = 0
/** 오버레이가 떠 있는 동안엔 출발 안내를 겹쳐 띄우지 않는다 */
let countdownVisible = false

function hideCountdown() {
  countdownVisible = false
  $('countdown').style.display = 'none'
}

async function runCountdown(generation: number) {
  const cd = $('countdown')
  const num = $('cd-num')
  const sub = $('cd-sub')
  const show = (text: string, hint: string, ready = false) => {
    num.textContent = text
    sub.textContent = hint
    cd.classList.toggle('ready', ready)
    // 애니메이션을 숫자마다 처음부터 다시 돌린다
    num.classList.remove('pop')
    void num.offsetWidth
    num.classList.add('pop')
  }
  const alive = () => generation === countdownGeneration
  countdownVisible = true
  cd.style.display = 'flex'
  show('준비', '손잡이를 잡고 캐치 자세로', true)
  await sleep(COUNTDOWN_READY_MS)
  for (const n of ['3', '2', '1']) {
    if (!alive()) return
    show(n, '')
    cues.countdown()
    await sleep(COUNTDOWN_STEP_MS)
  }
  if (!alive()) return
  show('시작', '노를 저으면 출발합니다')
  cues.go()
  setTimeout(() => { if (alive()) hideCountdown() }, COUNTDOWN_GO_MS)
}

$('btn-quit').addEventListener('click', () => {
  metronome.stop()
  ambience.stop()
  // 카운트다운 중이었다면 남은 숫자와 '시작' 소리를 끊는다
  countdownGeneration++
  hideCountdown()
  session?.finish()
  showSummary()
})

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
$('sim-drop').addEventListener('click', () => {
  if (source instanceof MockSource) source.simulateDropout(7000)
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
    const strokeCue = metronome.update(
      session.stroke.phase,
      session.stroke.spm,
      session.stroke.driveFraction,
      session.phase === 'running',
    )
    view.render(session, now / 1000, dt)
    const metrics = session.metrics()
    ambience.update({
      elapsedSec: metrics.elapsed,
      active: session.phase === 'running' && !metrics.stalled,
      strokeCue,
      presence: view.getAmbientPresence(),
    })
    updateHud()
    checkFeedback()
    if (session.phase === 'finished') {
      if (session.metrics().progress >= 0.999) cues.finish()
      showSummary()
    }
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
  const fb = buildFeedback(w, session.metrics().gap, idx, soon !== now ? soon : undefined)
  feedbackModal.show(fb)
  cues.feedback(fb.title)
}

let lmShownAt = -1

function renderRaceProfile() {
  const track = $('race-profile')
  const parts = profileSamples(selectedCourse.profile, selectedCourse.durationSec, 12)
    .map(value => {
      const part = document.createElement('span')
      part.className = value < 0.97 ? 'easy' : value > 1.03 ? 'hard' : 'steady'
      part.title = `목표 강도 ${Math.round(value * 100)}%`
      return part
    })
  const progress = document.createElement('i')
  progress.id = 's-prog'
  track.replaceChildren(...parts, progress)
  $('route-total').textContent = `${(raceTotal / 1000).toFixed(1)} km`
}

function drawMiniMap(distance: number, gap: number) {
  const canvas = $<HTMLCanvasElement>('mini-map')
  const cssSize = Math.max(90, canvas.clientWidth || 118)
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  const pixels = Math.round(cssSize * ratio)
  if (canvas.width !== pixels || canvas.height !== pixels) {
    canvas.width = pixels
    canvas.height = pixels
  }
  const context = canvas.getContext('2d')
  if (!context) return
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  const size = canvas.width / ratio
  const center = size / 2
  const baseY = size * 0.83
  const scaleForward = (size * 0.72) / 430
  const scaleSide = size / 54
  const mapPoint = (along: number, lateral: number) => {
    const point = localPathPoint(
      racePath, distance, along, lateral, PLAYER_LANE_OFFSET,
    )
    return { x: center + point.z * scaleSide, y: baseY - point.x * scaleForward }
  }

  context.clearRect(0, 0, size, size)
  context.save()
  context.beginPath()
  context.arc(center, center, center - 2, 0, Math.PI * 2)
  context.clip()
  context.fillStyle = 'rgba(8,17,25,.72)'
  context.fillRect(0, 0, size, size)

  const drawPath = (lateral: number, color: string, width: number) => {
    context.beginPath()
    for (let along = -70, i = 0; along <= 440; along += 10, i++) {
      const point = mapPoint(along, lateral)
      if (i === 0) context.moveTo(point.x, point.y)
      else context.lineTo(point.x, point.y)
    }
    context.strokeStyle = color
    context.lineWidth = width
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.stroke()
  }
  drawPath(0, 'rgba(54,188,229,.78)', 12)
  drawPath(BANK_MINI_OFFSET, 'rgba(220,230,232,.52)', 2.5)
  drawPath(-BANK_MINI_OFFSET, 'rgba(220,230,232,.52)', 2.5)
  drawPath(0, 'rgba(6,31,42,.55)', 1.5)

  const finishAlong = raceTotal - distance
  if (finishAlong > -35 && finishAlong < 440) {
    const left = mapPoint(finishAlong, 8)
    const right = mapPoint(finishAlong, -8)
    context.beginPath()
    context.moveTo(left.x, left.y)
    context.lineTo(right.x, right.y)
    context.setLineDash([3, 3])
    context.strokeStyle = '#fff'
    context.lineWidth = 3
    context.stroke()
    context.setLineDash([])
  }

  const pace = localPathPoint(
    racePath, distance, -gap, PACE_LANE_OFFSET, PLAYER_LANE_OFFSET,
  )
  const paceX = center + pace.z * scaleSide
  const paceY = baseY - pace.x * scaleForward
  if (paceY > -8 && paceY < size + 8) {
    context.beginPath()
    context.arc(paceX, paceY, 3.4, 0, Math.PI * 2)
    context.fillStyle = '#ff7b60'
    context.fill()
  }

  context.beginPath()
  context.moveTo(center, baseY - 7)
  context.lineTo(center - 5.5, baseY + 6)
  context.lineTo(center + 5.5, baseY + 6)
  context.closePath()
  context.fillStyle = '#fff'
  context.fill()
  context.restore()

  $('mini-caption').textContent = `${(distance / 1000).toFixed(1)} / ${(raceTotal / 1000).toFixed(1)} km`
}

const BANK_MINI_OFFSET = 15

function updateHud() {
  if (!session || !view) return
  const m = session.metrics()

  // 출발 대기: 첫 스트로크를 기다리는 동안 안내를 띄우고, 들어오는 순간 소리로 알린다
  const waiting = session.waitingForStroke
  const hint = $('start-hint')
  // 오버레이의 '시작' 글자가 사라진 뒤에 띄운다 — 같은 문장이 두 겹으로 보이면 안 된다
  hint.hidden = !waiting || countdownVisible
  if (waiting) {
    // 대기 중 연결이 끊겼거나 데이터가 안 오면 "노를 저으라"고만 하면 안 된다 — 죽은 연결에 대고 젓게 된다
    const [title, sub] = m.stallReason === 'link'
      ? ['연결이 끊어졌습니다', '다시 연결되면 노를 저어 출발하세요']
      : m.stallReason === 'nodata'
        ? ['로잉머신 데이터가 오지 않습니다', '콘솔을 깨우고 손잡이를 당겨보세요 · 계속 안 되면 연결 화면에서 다시 연결하세요']
        : ['노를 저으면 출발합니다', '페이스 보트가 옆에서 기다리는 중']
    hint.querySelector('b')!.textContent = title
    hint.querySelector('span')!.textContent = sub
  }
  if (lastPhase === 'armed' && session.phase === 'running') cues.launch()
  lastPhase = session.phase

  const splitText = formatSplitShort(m.split)
  $('s-split').textContent = splitText
  // 값이 없을 땐 왜 없는지 알려준다 — '--:--'만 덩그러니 있으면 고장난 것처럼 보인다
  $('dial-u').textContent = splitText === '--:--' ? '노를 저으면 표시됩니다' : '500m당 시간'
  $('s-target').textContent = formatSplitShort(m.targetSplit)
  $('s-dist').textContent = String(Math.round(m.distance))
  $('s-time').textContent = formatClock(m.elapsed)
  $('s-speed').textContent = (m.speed * 3.6).toFixed(1)
  $('s-calories').textContent = m.calories === undefined ? '—' : String(Math.round(m.calories))
  // 심박은 콘솔에 벨트가 붙어 있을 때만 온다. 없으면 0이나 빈칸 대신 '—'
  $('s-hr').textContent = m.heartRate === undefined || m.heartRate <= 0 ? '—' : String(Math.round(m.heartRate))
  $('s-spm').textContent = String(Math.round(m.spm))
  $('s-pow').textContent = String(Math.round(m.power))
  // 시간제 코스라 실제 완주 거리는 정해져 있지 않다. 페이스 보트 기준 예상 잔여 거리임을 명시한다.
  const targetLeft = m.remaining <= 0 ? 0 : Math.max(0, Math.round(raceTotal - m.distance + m.gap))
  $('s-remaining').textContent = `${formatClock(m.remaining)} 남음 · 목표 약 ${targetLeft.toLocaleString('en-US')}m`

  // 목표 대비 얼마나 벗어났는지 색으로. 값이 없으면 색도 없다 — 빨간 '--:--'는 고장처럼 보인다.
  const off = m.split - m.targetSplit
  const tone = splitText === '--:--' ? '' : off < -1.5 ? 'fast' : off > 1.5 ? 'slow' : ''
  $('s-split').className = 'v ' + tone
  updatePaceGauge(m.split, m.targetSplit, m.gap)
  $('pace-dial').style.setProperty('--dial-fill', `${Math.max(8, session.stroke.phase * 270)}deg`)

  // 현재 구간
  const seg = $('segment')
  seg.querySelector('.seg-label')!.textContent = m.step.label
  const rem = seg.querySelector('.seg-rem') as HTMLElement
  rem.textContent = m.step.remaining !== null ? formatClock(m.step.remaining) : ''
  seg.classList.toggle('hard', m.intensity > 1.03)
  seg.classList.toggle('easy', m.intensity < 0.97)

  // 다음 구간 — 몇 초 뒤에 어떤 페이스로 바뀌는지 미리 보여준다
  const next = $('next-panel')
  $('s-next-label').textContent = m.nextStep ? m.nextStep.label : '구간 변화 없음'
  $('s-next-in').textContent = m.nextStep ? `${formatClock(m.nextStep.startsIn)} 뒤` : ''
  $('s-next-target').textContent = m.nextTargetSplit === null ? '—' : formatSplitShort(m.nextTargetSplit)
  next.classList.toggle('hard', m.nextStep !== null && m.nextStep.intensity > m.intensity + 0.02)
  next.classList.toggle('easy', m.nextStep !== null && m.nextStep.intensity < m.intensity - 0.02)

  const gap = $('s-gap')
  const g = Math.round(m.gap)
  gap.textContent = `${g >= 0 ? '+' : ''}${g}m`
  gap.className = 'g ' + (g >= 0 ? 'ahead' : 'behind')

  // 지난 최고 기록 대비
  if (m.ghostGap !== null) {
    const gg = Math.round(m.ghostGap)
    const el = $('s-ghost-gap')
    el.textContent = `${gg >= 0 ? '+' : ''}${gg}m`
    el.className = 'gv ' + (gg >= 0 ? 'ahead' : 'behind')
  }

  // 구간이 바뀌면 소리로 알린다 — 화면을 안 봐도 되게
  if (lastStepLabel !== null && m.step.label !== lastStepLabel) {
    cues.segment(m.step.label, m.intensity > lastStepIntensity)
  }
  lastStepLabel = m.step.label
  lastStepIntensity = m.intensity

  // 연결 끊김 배너
  if (m.stallReason !== lastStallReason) {
    const wasStalled = lastStallReason !== null
    lastStallReason = m.stallReason
    const bar = $('linkbar')
    bar.classList.toggle('on', m.stalled)
    if (m.stalled) {
      $('link-txt').textContent = m.stallReason === 'link'
        ? '로잉머신 연결이 끊어졌습니다'
        : '로잉머신 데이터가 오지 않습니다'
      $('link-sub').textContent = m.stallReason === 'link'
        ? '자동으로 다시 연결하는 중 · 기록 시간은 멈춰 있습니다'
        : '손잡이를 한 번 당겨보세요 · 기록 시간은 멈춰 있습니다'
      if (!wasStalled) cues.linkLost()
    } else if (wasStalled) {
      cues.linkBack()
    }
  }

  $('s-prog').style.width = `${m.progress * 100}%`
  if (lastMiniMapAt < 0 || m.elapsed - lastMiniMapAt >= 0.1) {
    lastMiniMapAt = m.elapsed
    drawMiniMap(m.distance, m.gap)
  }

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

function updatePaceGauge(split: number, targetSplit: number, gap: number) {
  const gauge = $('pace-gauge')
  const g = paceGaugeState(split, targetSplit)
  gauge.style.setProperty('--pg-fill', `${(g.fill * 100).toFixed(1)}%`)
  gauge.style.setProperty('--pg-target', `${(g.target * 100).toFixed(1)}%`)
  gauge.style.setProperty(
    '--pg-color',
    g.state === 'behind' ? '#ff6252' : g.state === 'ahead' ? '#4bc67a' : '#36bce5',
  )
  gauge.className = `pace-gauge ${g.state}`
  $('pg-target').textContent = formatSplitShort(targetSplit)

  const msg = $('pg-msg')
  const boat = gap >= 0 ? `페이스 보트보다 ${Math.round(gap)}m 앞` : `페이스 보트보다 ${Math.abs(Math.round(gap))}m 뒤`
  switch (g.state) {
    case 'idle':
      msg.textContent = '노를 저어 목표 선까지 끌어올리세요'
      break
    case 'behind':
      msg.textContent = g.delta > 60
        ? `목표 속도까지 한참 남음 · 더 세게 당기세요 · ${boat}`
        : `목표보다 ${Math.round(g.delta)}초 느림 · 더 세게 당기세요 · ${boat}`
      break
    case 'ok':
      msg.textContent = `목표 페이스 유지 중 · ${boat}`
      break
    case 'ahead':
      msg.textContent = `목표보다 ${Math.round(-g.delta)}초 빠름 · ${boat}`
      break
  }
}

// ── 요약 ────────────────────────────────────────────────────
function showSummary() {
  if (!session) return
  metronome.stop()
  ambience.stop()
  const m = session.metrics()
  const s = session
  session = null
  unsub?.(); unsub = null
  unsubStatus?.(); unsubStatus = null
  $('linkbar').classList.remove('on')
  cues.stopSpeech()
  view?.dispose(); view = null
  feedbackModal.reset()
  releaseWakeLock()

  $('sum-title').textContent = m.progress >= 0.999 ? '코스 완주' : '세션 종료'

  const beat = m.gap >= 0
  const lines = [
    beat
      ? `<b>${s.course.name}</b>에서 페이스 보트를 <b>${Math.round(m.gap)}m</b> 앞섰습니다.`
      : `<b>${s.course.name}</b>에서 페이스 보트에 <b>${Math.abs(Math.round(m.gap))}m</b> 뒤졌습니다.`,
  ]

  // 고스트(지난 최고 기록) 대비.
  // ⚠️ 이번 세션을 저장하기 전에 비교해야 한다 — 저장 후엔 이번 기록이 최고가 되어버린다.
  const prevBest = s.ghost?.record ?? null
  if (prevBest && m.progress >= 0.999) {
    const diff = m.distance - prevBest.distance
    lines.push(
      diff >= 0
        ? `지난 최고 기록을 <b>${Math.round(diff)}m</b> 넘었습니다. 새 기록입니다.`
        : `지난 최고 기록에 <b>${Math.abs(Math.round(diff))}m</b> 못 미쳤습니다.`,
    )
    if (diff >= 0) $('sum-title').textContent = '새 최고 기록'
  }
  $('sum-verdict').innerHTML = lines.join('<br>')

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
  const generation = ++wakeLockGeneration
  try {
    const acquired = await navigator.wakeLock?.request('screen') ?? null
    if (generation !== wakeLockGeneration) {
      await acquired?.release().catch(() => {})
      return null
    }
    wakeLock = acquired
    return acquired
  } catch {
    return null // 미지원 또는 권한 거부
  }
}
function releaseWakeLock() {
  // 아직 pending인 request도 무효화한다. 나중에 resolve되면 requestWakeLock이 곧바로 해제한다.
  wakeLockGeneration++
  wakeLock?.release().catch(() => {})
  wakeLock = null
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && $('screen-race').classList.contains('active')) {
    requestWakeLock()
    void metronome.unlock()
    cues.primeSpeech()
    void ambience.prepare()
  } else if (document.visibilityState !== 'visible') {
    metronome.stop()
    ambience.stop()
  }
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
