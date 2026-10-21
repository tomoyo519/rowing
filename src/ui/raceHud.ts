import type { Course } from '../game/courses'
import type { Metrics } from '../game/state'
import {
  localPathPoint, PACE_LANE_OFFSET, PLAYER_LANE_OFFSET, type CoursePath,
} from '../game/coursePath'
import {
  paceGaugeBar, paceGaugeState, paceGaugeTicks, paceGaugeTolerance, type PaceGaugeState,
} from '../game/paceGauge'
import { formatClock, formatSplitShort } from '../game/physics'
import { profileStripSvg } from './charts'

/**
 * 레이스 HUD의 숫자·그래프 렌더링.
 *
 * 노를 젓는 사람은 1m 밖에서 한 번 흘깃 보고 "얼마나 빠른지, 충분한지, 얼마나 차이나는지"를 읽어야 한다.
 * 그래서
 *  - 현재 스플릿은 한 곳(가운데 큰 숫자)에만 있고, 그 바로 아래 목표 대비 초 차이가 부호·색·단어와 함께 선다.
 *  - 목표 게이지는 가운데가 목표인 양방향 막대다 — 방향과 크기가 한눈에 들어온다.
 *  - 표시용 스플릿·파워는 0.8초 지수평활로 다듬는다. 1~2Hz로 들어오는 샘플을 60fps로 그대로 뿌리면
 *    경계에서 2:19↔2:20이 떨리고, 큰 숫자는 떨리면 읽을 수 없다. 기록·판정은 원래 값을 쓴다.
 *  - DOM 쓰기는 값이 바뀔 때만 한다 (setText 캐시). 매 프레임 20개 문자열을 다시 쓰면 iPad가 레이아웃을 다시 잡는다.
 */
export interface StrokeView {
  /** 0..1 스트로크 위상 */
  phase: number
  /** 드라이브가 차지하는 위상 비율 */
  driveFraction: number
}

const BANK_MINI_OFFSET = 15
const MINI_RING = '#0f1a24'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

function ema(prev: number, next: number, dt: number, tau: number) {
  if (!isFinite(prev)) return next
  return prev + (next - prev) * (1 - Math.exp(-dt / tau))
}

export class RaceHud {
  private course: Course | null = null
  private path: CoursePath | null = null
  private total = 1
  private text = new Map<string, string>()
  private cls = new Map<string, string>()
  private dispSplit = Infinity
  private dispSpeed = 0
  private dispPow = 0
  private splitText = '--:--'
  private lastGaugeState: PaceGaugeState | null = null
  private lastStepLabel: string | null = null
  private stepTotal = 0
  private lastMiniMapAt = -1
  private lastPhase = 0
  private hasGhost = false

  constructor() {
    this.buildGaugeTicks()
  }

  /** 눈금은 한 번만 만든다 — 5초마다 가는 선 */
  private buildGaugeTicks() {
    const track = $('pg-track')
    for (const tick of track.querySelectorAll('.pg-tick')) tick.remove()
    const fragment = document.createDocumentFragment()
    for (const t of paceGaugeTicks()) {
      const i = document.createElement('i')
      i.className = 'pg-tick'
      i.style.left = `${t.pct}%`
      fragment.append(i)
    }
    track.prepend(fragment)
    const tol = paceGaugeTolerance()
    const gauge = $('pace-gauge')
    gauge.style.setProperty('--pg-tl', `${tol.left.toFixed(2)}%`)
    gauge.style.setProperty('--pg-tr', `${tol.right.toFixed(2)}%`)
  }

  /** 레이스 시작 — 코스 띠를 그리고 캐시를 비운다 */
  start(course: Course, path: CoursePath, total: number, hasGhost: boolean) {
    this.course = course
    this.path = path
    this.total = total
    this.hasGhost = hasGhost
    this.text.clear()
    this.cls.clear()
    this.dispSplit = Infinity
    this.dispSpeed = 0
    this.dispPow = 0
    this.splitText = '--:--'
    this.lastGaugeState = null
    this.lastStepLabel = null
    this.stepTotal = 0
    this.lastMiniMapAt = -1
    this.lastPhase = 0
    $('ghost-gap').classList.toggle('on', hasGhost)
    $('mini-legend').textContent = hasGhost ? '▲ 나 · ● 페이스 보트 · ○ 내 최고' : ''
    this.setText('route-total', `${(total / 1000).toFixed(1)} km`)
    this.renderProfile()
  }

  /** 레이스 중 목표 페이스가 바뀌면 페이스 보트의 예상 완주 거리, 곧 결승선이 옮겨진다 */
  setTotal(total: number) {
    this.total = Math.max(1, total)
    this.setText('route-total', `${(this.total / 1000).toFixed(1)} km`)
    this.lastMiniMapAt = -1
  }

  /** 사용자가 목표 페이스를 바꿨다 — 목표 숫자가 한 번 튀어 "바뀌었다"를 알린다 */
  pulseTarget() {
    const el = $('pg-target')
    el.classList.remove('settle')
    void el.offsetWidth
    el.classList.add('settle')
  }

  /** 화면 크기가 바뀌면 코스 띠를 새 폭으로 다시 그린다 (늘리지 않으므로 선 두께가 유지된다) */
  resize() {
    this.renderProfile()
    this.lastMiniMapAt = -1
  }

  private renderProfile() {
    if (!this.course) return
    const host = $('race-profile')
    const width = host.clientWidth || 600
    host.innerHTML = profileStripSvg(this.course, width)
  }

  private setText(id: string, value: string) {
    if (this.text.get(id) === value) return
    this.text.set(id, value)
    $(id).textContent = value
  }

  private setClass(id: string, value: string) {
    if (this.cls.get(id) === value) return
    this.cls.set(id, value)
    // SVG 요소의 className은 읽기 전용(SVGAnimatedString)이라 속성으로 쓴다
    $(id).setAttribute('class', value)
  }

  /**
   * @param m       세션 지표
   * @param stroke  스트로크 위상 (리듬 링·박동)
   * @param running 출발 뒤인지
   * @param dt      프레임 간격 (초)
   */
  update(m: Metrics, stroke: StrokeView, running: boolean, dt: number) {
    // ── 상단 지표 ─────────────────────────────────────────
    this.setText('s-time', formatClock(m.elapsed))
    this.setText('s-dist', String(Math.round(m.distance)))
    this.setText('s-avg', formatSplitShort(m.avgSplit))
    this.setText('s-calories', m.calories === undefined ? '—' : String(Math.round(m.calories)))
    const hr = m.heartRate !== undefined && m.heartRate > 0 ? Math.round(m.heartRate) : 0
    this.setText('s-hr', hr > 0 ? String(hr) : '—')
    this.setClass('stat-cal', `stat${m.calories === undefined ? ' na' : ''}`)
    this.setClass('stat-hr', `stat${hr > 0 ? ' live' : ' na'}`)
    if (hr > 0) $('stat-hr').style.setProperty('--beat', `${(60 / hr).toFixed(2)}s`)

    // ── 현재 페이스 (표시용 평활) ─────────────────────────
    // 속도로 평활한 뒤 스플릿으로 바꾼다. 스플릿(초/500m)을 직접 평균하면 스트로크 안의 빠른·느린 순간이
    // 느린 쪽으로 치우쳐서(조화평균) 화면은 목표대로인데 실제로는 더 빨라 페이스 보트가 뒤로 처진다.
    const live = isFinite(m.split) && m.split > 0 && m.split < 600
    this.dispSpeed = live ? (this.dispSpeed > 0 ? ema(this.dispSpeed, m.speed, dt, 0.8) : m.speed) : 0
    this.dispSplit = this.dispSpeed > 0 ? 500 / this.dispSpeed : Infinity
    const candidate = formatSplitShort(this.dispSplit)
    if (candidate !== this.splitText) {
      // 정수 초 경계를 0.4초 넘게 지나야 글자가 바뀐다 — 경계에서 2:19↔2:20이 떨리지 않는다
      const frac = isFinite(this.dispSplit) ? this.dispSplit - Math.floor(this.dispSplit) : 0.5
      // '--:--'에서 처음 숫자가 생길 때와 숫자가 사라질 때는 기다리지 않는다 — 안 그러면 고른 페이스에선 첫 숫자가 한참 안 뜬다
      if (!isFinite(this.dispSplit) || frac > 0.4 || frac < 0.1 || candidate === '--:--' || this.splitText === '--:--') {
        this.splitText = candidate
        const hero = $('s-split')
        hero.classList.remove('settle')
        void hero.offsetWidth
        hero.classList.add('settle')
      }
    }
    this.setText('s-split', this.splitText)
    const idle = this.splitText === '--:--'
    // 기기가 페이스를 안 주거나(또는 단위가 틀려 버렸거나) 거리 증가분으로 잰 값이면 그렇다고 적는다 — 숫자가 조금 더 거칠다
    this.setText('dial-u', idle ? '노를 저으면 표시됩니다' : m.speedSource === 'distance' ? '거리로 계산한 페이스' : '')
    this.dispPow = ema(this.dispPow, m.power, dt, 1.0)
    this.setText('s-pow', String(Math.round(this.dispPow)))
    this.setText('s-spm', String(Math.round(m.spm)))

    // ── 목표 게이지 ───────────────────────────────────────
    const g = paceGaugeState(this.dispSplit, m.targetSplit)
    const gauge = $('pace-gauge')
    const bar = paceGaugeBar(g.delta)
    gauge.style.setProperty('--pg-l', `${bar.left.toFixed(2)}%`)
    gauge.style.setProperty('--pg-r', `${bar.right.toFixed(2)}%`)
    if (g.state !== this.lastGaugeState) {
      const entering = this.lastGaugeState !== null && g.state === 'behind'
      this.lastGaugeState = g.state
      gauge.classList.remove('idle', 'behind', 'ok', 'ahead', 'enter')
      gauge.classList.add(g.state)
      if (entering) { void gauge.offsetWidth; gauge.classList.add('enter') }
    }
    this.setText('pg-target', formatSplitShort(m.targetSplit))
    const whole = isFinite(g.delta) ? Math.min(99, Math.round(Math.abs(g.delta))) : 0
    this.setText('pg-delta-n', g.state === 'idle' ? '—' : `${g.delta > 0 ? '+' : '−'}${whole}`)
    this.setText('pg-word', g.state === 'behind' ? '느림' : g.state === 'ahead' ? '빠름' : g.state === 'ok' ? '유지' : '')
    const gap = Math.round(m.gap)
    const boat = gap >= 0 ? `페이스 보트보다 ${gap}m 앞` : `페이스 보트보다 ${Math.abs(gap)}m 뒤`
    this.setText('pg-msg-main', g.state === 'idle'
      ? (running ? '노를 저어 목표 선까지 끌어올리세요' : '페이스 보트를 따라가세요')
      : g.state === 'behind' ? (g.delta > 60 ? '목표까지 한참 남음 · 더 세게 당기세요' : '더 세게 당기세요')
        : g.state === 'ok' ? '목표 페이스 유지 중' : '여유 있음 · 이대로')
    this.setText('pg-msg-sub', running ? boat : '')
    // 큰 숫자 옆 상태 칩: 점(색) + 글자 — 색만으로 뜻을 나르지 않는다
    const off = this.dispSplit - m.targetSplit
    const tone = idle ? '' : off < -1.5 ? 'fast' : off > 1.5 ? 'slow' : ''
    this.setClass('dial-state', `dial-state ${tone}`)
    this.setText('dial-state', idle ? '' : tone === 'fast' ? `${Math.round(-off)}초 빠름` : tone === 'slow' ? `${Math.round(off)}초 느림` : '목표 페이스')

    // ── 구간 카드 ─────────────────────────────────────────
    const bucket = (v: number) => v < 0.97 ? 'easy' : v > 1.03 ? 'hard' : ''
    this.setText('seg-label', m.step.label)
    this.setText('seg-rem', m.step.remaining !== null ? formatClock(m.step.remaining) : '')
    this.setText('s-target', formatSplitShort(m.targetSplit))
    this.setClass('seg-int', `int-chip ${bucket(m.intensity)}`)
    this.setText('seg-int-b', `${Math.round(m.intensity * 100)}%`)
    if (m.step.label !== this.lastStepLabel) {
      this.lastStepLabel = m.step.label
      this.stepTotal = m.step.remaining ?? 0
    }
    const left = this.stepTotal > 0 && m.step.remaining !== null ? m.step.remaining / this.stepTotal : 1
    $('seg-card').style.setProperty('--seg-left', left.toFixed(3))
    $('seg-bar-fill').style.background = `var(--int-${bucket(m.intensity) === 'easy' ? 1 : bucket(m.intensity) === 'hard' ? 3 : 2})`

    const next = m.nextStep
    this.setText('s-next-label', next ? next.label : '구간 변화 없음')
    this.setText('s-next-in', next ? `${formatClock(next.startsIn)} 뒤` : '')
    this.setText('s-next-target', m.nextTargetSplit === null ? '—' : formatSplitShort(m.nextTargetSplit))
    this.setClass('next-int', `int-chip ${next ? bucket(next.intensity) : ''}`)
    this.setText('next-int-b', next ? `${Math.round(next.intensity * 100)}%` : '—')
    const up = next !== null && next.intensity > m.intensity + 0.02
    const down = next !== null && next.intensity < m.intensity - 0.02
    this.setClass('next-dir', `next-dir ${up ? 'up' : down ? 'down' : ''}`)
    this.setText('next-dir', next ? (up ? '▲ 더 세게' : down ? '▼ 더 느리게' : '● 그대로') : '')
    // 시간제 코스라 실제 완주 거리는 정해져 있지 않다. 페이스 보트 기준 예상 잔여 거리임을 명시한다.
    const targetLeft = m.remaining <= 0 ? 0 : Math.max(0, Math.round(this.total - m.distance + m.gap))
    this.setText('s-remaining', `${formatClock(m.remaining)} 남음 · 목표 약 ${targetLeft.toLocaleString('en-US')}m`)

    // ── 페이스 보트·최고 기록 차이 ───────────────────────
    this.setText('s-gap', `${gap >= 0 ? '▲' : '▼'} ${Math.abs(gap)} m`)
    this.setClass('gap-chip', `gap-chip glass ${gap >= 0 ? 'ahead' : 'behind'}`)
    if (m.ghostGap !== null) {
      const gg = Math.round(m.ghostGap)
      this.setText('s-ghost-gap', `${gg >= 0 ? '▲' : '▼'} ${Math.abs(gg)} m`)
      this.setClass('ghost-gap', `gap-chip glass ghost on ${gg >= 0 ? 'ahead' : 'behind'}`)
    }

    // ── 리듬 링과 박동 ────────────────────────────────────
    const df = Math.max(1e-3, Math.min(0.999, stroke.driveFraction))
    const inDrive = stroke.phase < df
    const ring = inDrive ? stroke.phase / df : 1 - (stroke.phase - df) / (1 - df)
    const ph = $('ph-ring')
    ph.style.strokeDashoffset = (1 - Math.max(0, Math.min(1, ring))).toFixed(3)
    this.setClass('ph-ring', `ph-fg${inDrive ? ' drive' : ''}`)
    if (running && stroke.phase < this.lastPhase - 0.5) {
      const spm = $('s-spm')
      spm.classList.remove('beat')
      void spm.offsetWidth
      spm.classList.add('beat')
    }
    this.lastPhase = stroke.phase

    // ── 코스 띠와 미니맵 (10Hz) ───────────────────────────
    if (this.lastMiniMapAt < 0 || m.elapsed - this.lastMiniMapAt >= 0.1) {
      this.lastMiniMapAt = m.elapsed
      const host = $('race-profile')
      const width = host.clientWidth || 600
      const px = (m.progress * width).toFixed(1)
      const done = document.getElementById('prof-done-r')
      done?.setAttribute('width', px)
      for (const id of ['s-prog', 's-prog-ring']) {
        const line = document.getElementById(id)
        line?.setAttribute('x1', px)
        line?.setAttribute('x2', px)
      }
      this.drawMiniMap(m)
    }
  }

  /**
   * 미니맵: 강은 중립적인 청회색(상태색이 아니다), 세 보트는 모양으로 구분한다 —
   * 나는 삼각형, 페이스 보트는 찬 점, 지난 최고 기록은 빈 고리. 표식마다 2px 어두운 테두리가 있어 강 위에서도 보인다.
   * 다음 구간 경계는 강을 가로지르는 막대 — 페이스 보트가 속도를 바꿀 자리가 코스 띠와 같은 색으로 보인다.
   */
  private drawMiniMap(m: Metrics) {
    if (!this.path) return
    const path = this.path
    const canvas = $<HTMLCanvasElement>('mini-map')
    const cssSize = Math.max(90, canvas.clientWidth || 118)
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const pixels = Math.round(cssSize * ratio)
    if (canvas.width !== pixels || canvas.height !== pixels) {
      canvas.width = pixels
      canvas.height = pixels
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    const size = canvas.width / ratio
    const center = size / 2
    const baseY = size * 0.80
    const scaleForward = (size * 0.70) / 430
    const scaleSide = size / 54
    const distance = m.distance
    const mapPoint = (along: number, lateral: number) => {
      const point = localPathPoint(path, distance, along, lateral, PLAYER_LANE_OFFSET)
      return { x: center + point.z * scaleSide, y: baseY - point.x * scaleForward }
    }

    ctx.clearRect(0, 0, size, size)
    ctx.save()
    ctx.beginPath()
    ctx.arc(center, center, center - 1, 0, Math.PI * 2)
    ctx.clip()

    const drawPath = (lateral: number, color: string | CanvasGradient, width: number) => {
      ctx.beginPath()
      for (let along = -70, i = 0; along <= 440; along += 10, i++) {
        const point = mapPoint(along, lateral)
        if (i === 0) ctx.moveTo(point.x, point.y)
        else ctx.lineTo(point.x, point.y)
      }
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.stroke()
    }
    // 강둑 사이의 땅, 강, 가운데 하이라이트, 둑선
    drawPath(0, 'rgba(34,58,44,.75)', BANK_MINI_OFFSET * 2 * scaleSide)
    const river = ctx.createLinearGradient(0, 0, 0, size)
    river.addColorStop(0, 'rgba(96,128,152,.55)')
    river.addColorStop(1, 'rgba(150,186,208,.85)')
    drawPath(0, river, 13)
    drawPath(0, 'rgba(255,255,255,.14)', 2)
    drawPath(BANK_MINI_OFFSET, 'rgba(214,226,214,.4)', 1.2)
    drawPath(-BANK_MINI_OFFSET, 'rgba(214,226,214,.4)', 1.2)

    // 다음 구간 경계
    if (m.boundaryAlong !== null && m.nextStep && m.boundaryAlong > -20 && m.boundaryAlong < 440) {
      const a = mapPoint(m.boundaryAlong, 9), b = mapPoint(m.boundaryAlong, -9)
      const up = m.nextStep.intensity > m.intensity + 0.02, down = m.nextStep.intensity < m.intensity - 0.02
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.strokeStyle = MINI_RING
      ctx.lineWidth = 5
      ctx.stroke()
      ctx.strokeStyle = up ? '#f0851a' : down ? '#ffd89a' : '#ffb648'
      ctx.lineWidth = 3
      ctx.stroke()
    }

    // 결승선: 체크무늬
    const finishAlong = this.total - distance
    if (finishAlong > -35 && finishAlong < 440) {
      const left = mapPoint(finishAlong, 8)
      const right = mapPoint(finishAlong, -8)
      const n = 8
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n
        ctx.beginPath()
        ctx.moveTo(left.x + (right.x - left.x) * t0, left.y + (right.y - left.y) * t0)
        ctx.lineTo(left.x + (right.x - left.x) * t1, left.y + (right.y - left.y) * t1)
        ctx.strokeStyle = i % 2 ? '#111' : '#fff'
        ctx.lineWidth = 3
        ctx.lineCap = 'butt'
        ctx.stroke()
      }
    }

    const ringed = (x: number, y: number, r: number, fill: string | null) => {
      ctx.beginPath()
      ctx.arc(x, y, r + 2, 0, Math.PI * 2)
      ctx.fillStyle = MINI_RING
      ctx.fill()
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      if (fill) { ctx.fillStyle = fill; ctx.fill() }
      else { ctx.lineWidth = 1.6; ctx.strokeStyle = '#fff'; ctx.stroke() }
    }
    // 페이스 보트 — 찬 점
    const pace = localPathPoint(path, distance, -m.gap, PACE_LANE_OFFSET, PLAYER_LANE_OFFSET)
    const paceX = center + pace.z * scaleSide
    const paceY = baseY - pace.x * scaleForward
    if (paceY > -8 && paceY < size + 8) ringed(paceX, paceY, 4, '#ffffff')
    // 지난 최고 기록 — 빈 고리
    if (this.hasGhost && m.ghostGap !== null) {
      const ghost = localPathPoint(path, distance, -m.ghostGap, PLAYER_LANE_OFFSET, PLAYER_LANE_OFFSET)
      const gx = center + ghost.z * scaleSide
      const gy = baseY - ghost.x * scaleForward
      if (gy > -8 && gy < size + 8) ringed(gx, gy, 4, null)
    }
    // 나 — 삼각형
    ctx.beginPath()
    ctx.moveTo(center, baseY - 8)
    ctx.lineTo(center - 6, baseY + 6)
    ctx.lineTo(center + 6, baseY + 6)
    ctx.closePath()
    ctx.lineJoin = 'round'
    ctx.lineWidth = 4
    ctx.strokeStyle = MINI_RING
    ctx.stroke()
    ctx.fillStyle = '#fff'
    ctx.fill()
    ctx.restore()

    canvas.setAttribute('aria-label', `앞으로 ${Math.max(0, Math.round(this.total - distance))}m, 페이스 보트 ${m.gap >= 0 ? '+' : ''}${Math.round(m.gap)}m`)
    const caption = $('mini-caption')
    const text = `${(distance / 1000).toFixed(1)} / ${(this.total / 1000).toFixed(1)} km`
    if (this.text.get('mini-caption') !== text) {
      this.text.set('mini-caption', text)
      caption.innerHTML = `<b>${(distance / 1000).toFixed(1)}</b> / ${(this.total / 1000).toFixed(1)} km`
    }
  }
}
