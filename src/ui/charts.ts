import type { Course } from '../game/courses'
import { intensityAt, profileSections } from '../game/profile'
import { formatClock, formatSplit, formatSplitShort } from '../game/physics'

/**
 * HUD·카드·기록 화면의 차트.
 *
 * 전부 인라인 SVG 문자열이다 — 폰트·이미지 파일 없이 그려지고, 테스트에서 DOM 없이 검증할 수 있다.
 *
 * 색의 역할을 나눈다:
 *  - 강도(얼마나 센 구간인지)는 **서열(ordinal)** 값이라 한 색상(호박색)의 밝기 단계로만 표현한다.
 *  - 목표 대비 빠름/느림은 **상태(status)** 값이라 초록/빨강을 쓴다. 두 역할이 같은 색을 쓰면
 *    코스 그래프의 붉은 구간이 "내가 뒤처졌다"로 읽히므로 섞지 않는다.
 *  - 글자는 색을 입지 않는다. 상태는 글자 옆의 점·화살표가 나른다.
 */

/** 코스 강도 그래프의 고정 세로 범위 — 모든 코스가 같은 자로 그려져 서로 비교된다 */
export const PROFILE_LO = 0.82
export const PROFILE_HI = 1.35

export interface SplitPoint {
  t: number
  split: number
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toString()

function clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v }

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

/** 강도 색 램프(호박색)를 세로 그라데이션으로. y는 강도→세로 위치 함수, lo~hi는 그 그래프의 강도 범위 */
function intensityGradient(id: string, y: (v: number) => number, lo = PROFILE_LO, hi = PROFILE_HI) {
  const at = (v: number) => f1(Math.max(0, Math.min(1, (v - lo) / (hi - lo))))
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${f1(y(lo))}" x2="0" y2="${f1(y(hi))}">
    <stop offset="0" stop-color="var(--int-0, #fff1d6)"/>
    <stop offset="${at(1.0)}" stop-color="var(--int-1, #ffd89a)"/>
    <stop offset="${at(1.0 + (hi - 1.0) * 0.5)}" stop-color="var(--int-2, #ffb648)"/>
    <stop offset="1" stop-color="var(--int-3, #f0851a)"/>
  </linearGradient>`
}

/** 코스 강도를 n개로 샘플링 (고정 범위로 자른다) */
export function intensitySamples(course: Course, n: number): number[] {
  return Array.from({ length: n }, (_, i) =>
    clamp(intensityAt(course.profile, (i / (n - 1)) * course.durationSec), PROFILE_LO, PROFILE_HI))
}

/**
 * 레이스 화면 상단의 코스 띠.
 * 지나온 부분은 또렷하고 앞으로 올 부분은 흐리다(강조는 지나온 쪽). 기준 페이스(1.0)에 가는 선,
 * 구간 경계는 2px 틈, 5분마다 아래 눈금. 재생 헤드는 흰 선 + 어두운 테두리.
 * 폭을 재서 그리므로(늘리지 않음) 틈·선이 늘 같은 두께다.
 */
export function profileStripSvg(course: Course, width: number, height = 24, samples = 240): string {
  const W = Math.max(120, Math.round(width)), H = height, D = course.durationSec
  const y = (v: number) => H - 1 - ((clamp(v, PROFILE_LO, PROFILE_HI) - PROFILE_LO) / (PROFILE_HI - PROFILE_LO)) * (H - 2)
  const ys = intensitySamples(course, samples)
  const pts = ys.map((v, i) => `${f1((i / (samples - 1)) * W)},${f1(y(v))}`)
  const area = `M0,${H} L${pts.join(' L')} L${W},${H} Z`
  const line = `M${pts.join(' L')}`
  const gaps = profileSections(course.profile, D).slice(1)
    .map(s => `<rect x="${f1((s.start / D) * W - 1)}" y="0" width="2" height="${H}" fill="var(--hud-ring, #0f1a24)"/>`)
    .join('')
  const ticks: string[] = []
  for (let t = 300; t < D; t += 300) {
    const x = f1((t / D) * W)
    ticks.push(`<line x1="${x}" x2="${x}" y1="${H - 5}" y2="${H}" stroke="rgba(255,255,255,.55)" stroke-width="1"/>`)
  }
  const sections = profileSections(course.profile, D)
    .map(s => `<li>${formatClock(s.start)}–${formatClock(s.end)} ${escapeHtml(s.label)}</li>`).join('')
  return `<svg class="pf-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(course.name)} 강도 프로파일" aria-describedby="race-profile-alt">
    <defs>${intensityGradient('pf-int', y)}
      <clipPath id="prof-done"><rect id="prof-done-r" x="0" y="-2" width="0" height="${H + 4}"/></clipPath></defs>
    <path d="${area}" fill="url(#pf-int)" fill-opacity=".48"/>
    <path d="${line}" fill="none" stroke="var(--int-1, #ffd89a)" stroke-opacity=".8" stroke-width="1.3" stroke-linejoin="round"/>
    <g clip-path="url(#prof-done)">
      <path d="${area}" fill="url(#pf-int)" fill-opacity="1"/>
      <path d="${line}" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    </g>
    <line x1="0" x2="${W}" y1="${f1(y(1))}" y2="${f1(y(1))}" stroke="rgba(255,255,255,.38)" stroke-width="1"/>
    ${ticks.join('')}${gaps}
    <line id="s-prog-ring" x1="0" x2="0" y1="-3" y2="${H + 3}" stroke="var(--hud-ring, #0f1a24)" stroke-width="6" stroke-linecap="round"/>
    <line id="s-prog" x1="0" x2="0" y1="-3" y2="${H + 3}" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
  </svg><ul class="sr-only" id="race-profile-alt">${sections}</ul>`
}

/**
 * 코스 카드의 작은 그래프. 기준 페이스(1.0)에 가는 선을 긋고 그 위로 솟은 만큼을 호박색으로 채운다.
 * 세로 범위는 카드마다 잡되 최소 0.88~1.12는 보장한다 — ±3%짜리 잔물결도 모양이 보이고,
 * 스프린트처럼 큰 코스는 그만큼 더 솟는다 (정확한 범위는 카드의 '페이스 97~103%' 글자가 말해 준다).
 * 가장 센 곳이 기준보다 5% 넘게 높으면 그 자리에 ×1.28 같은 값을 하나만 적는다.
 */
export function sparklineSvg(course: Course, id = course.id): string {
  const N = 96, W = 100, H = 44
  const raw = Array.from({ length: N }, (_, i) => intensityAt(course.profile, (i / (N - 1)) * course.durationSec))
  const lo = Math.min(...raw, 0.88), hi = Math.max(...raw, 1.12)
  const y = (v: number) => H - 3 - ((clamp(v, lo, hi) - lo) / (hi - lo)) * (H - 6)
  const pts = raw.map((v, i) => `${f1((i / (N - 1)) * W)},${f1(y(v))}`)
  const yb = f1(y(1))
  const area = `M0,${yb} L${pts.join(' L')} L${W},${yb} Z`
  const peakI = raw.indexOf(Math.max(...raw))
  const peak = raw[peakI]!
  const ticks: string[] = []
  for (let t = 600; t < course.durationSec; t += 600) {
    const x = f1((t / course.durationSec) * W)
    ticks.push(`<line x1="${x}" x2="${x}" y1="${H - 3}" y2="${H}" class="spark-tick"/>`)
  }
  const gid = `sp-${id}`
  return `<div class="spark-wrap"><svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <defs>${intensityGradient(gid, y, lo, hi)}</defs>
    <path d="${area}" fill="url(#${gid})" fill-opacity=".7"/>
    <line x1="0" x2="${W}" y1="${yb}" y2="${yb}" class="spark-base"/>
    <polyline points="${pts.join(' ')}" class="spark-line"/>${ticks.join('')}
  </svg>${peak > 1.05 ? `<span class="spark-peak num" style="left:${f1((peakI / (N - 1)) * 100)}%">×${peak.toFixed(2)}</span>` : ''}</div>`
}

// ── 스플릿 추이 차트 (기록·요약) ──────────────────────────

export interface SplitChartOptions {
  /** DOM id 접두사 — 한 화면에 여러 차트가 있어도 clipPath id가 겹치지 않게 */
  id: string
  curve: SplitPoint[]
  /** 기준 스플릿 (초/500m). 코스가 있으면 목표선 = base / intensity(t) */
  baseSplit: number
  course: Course | null
  durationSec: number
  width: number
  height?: number
}

export interface SplitChartPoint extends SplitPoint {
  x: number
  y: number
  /** 그 시각의 목표 스플릿. 코스를 모르면 null */
  target: number | null
}

export interface SplitChartModel {
  html: string
  points: SplitChartPoint[]
  plot: { l: number; r: number; t: number; b: number; W: number; H: number }
  tMax: number
  lo: number
  hi: number
  step: number
}

/** 스플릿 축의 깔끔한 범위 — 5초 또는 10초 눈금에 맞춘다 */
export function niceSplitDomain(lo: number, hi: number): { lo: number; hi: number; step: number } {
  const span = Math.max(1, hi - lo)
  const step = span > 60 ? 10 : 5
  const nlo = Math.floor(lo / step) * step
  let nhi = Math.ceil(hi / step) * step
  if (nhi - nlo < step * 2) nhi = nlo + step * 2
  return { lo: nlo, hi: nhi, step }
}

/**
 * 스플릿 추이 차트 모델. y는 뒤집는다 — 스플릿이 작을수록 빠르므로 위가 빠른 쪽.
 * 목표선을 알면 그보다 빠른 구간은 초록, 느린 구간은 빨강으로 사이를 옅게 칠한다(목표 대비 = 상태 색).
 * 직접 표기는 가장 빠른 지점 하나와 끝점뿐이고, 나머지 값은 눈금·툴팁·표가 맡는다.
 */
export function buildSplitChart(o: SplitChartOptions): SplitChartModel | null {
  const pts = o.curve.filter(p => isFinite(p.split) && p.split > 0 && p.split < 600)
  if (pts.length < 2) return null
  const W = Math.max(200, Math.round(o.width)), H = o.height ?? 140
  const plot = { l: 48, r: 16, t: 14, b: 24, W, H }
  const tMax = Math.max(o.durationSec || 0, pts[pts.length - 1]!.t, 1)
  const hasTarget = o.course !== null && isFinite(o.baseSplit) && o.baseSplit > 0
  const target = (t: number) => hasTarget ? o.baseSplit / intensityAt(o.course!.profile, t) : null

  const TN = 121
  const targetLine = hasTarget
    ? Array.from({ length: TN }, (_, i) => ({ t: (i / (TN - 1)) * tMax, split: target((i / (TN - 1)) * tMax)! }))
    : []
  let lo = Math.min(...pts.map(p => p.split)) - 2
  let hi = Math.max(...pts.map(p => p.split)) + 2
  if (targetLine.length) {
    lo = Math.min(lo, Math.min(...targetLine.map(p => p.split)) - 4)
    hi = Math.max(hi, Math.max(...targetLine.map(p => p.split)) + 4)
  }
  const domain = niceSplitDomain(lo, hi)
  lo = domain.lo; hi = domain.hi
  const x = (t: number) => plot.l + (t / tMax) * (W - plot.l - plot.r)
  const y = (s: number) => plot.t + ((s - lo) / (hi - lo)) * (H - plot.t - plot.b)

  const points: SplitChartPoint[] = pts.map(p => ({ t: p.t, split: p.split, x: x(p.t), y: y(p.split), target: target(p.t) }))

  // 눈금과 격자 (실선 헤어라인, 글자는 흐린 잉크)
  const grid: string[] = []
  // 눈금이 촘촘하면 글자는 하나 걸러 적는다 — 선은 다 긋는다
  const tickCount = Math.round((hi - lo) / domain.step)
  const labelEvery = tickCount > 7 ? 2 : 1
  for (let k = 0, s = lo; s <= hi + 1e-6; s += domain.step, k++) {
    const yy = f1(y(s))
    grid.push(`<line class="hgrid" x1="${plot.l}" x2="${W - plot.r}" y1="${yy}" y2="${yy}"/>`)
    if (k % labelEvery === 0 || k === tickCount) {
      grid.push(`<text class="htick num" x="${plot.l - 8}" y="${f1(y(s) + 3.5)}" text-anchor="end">${formatSplitShort(s)}</text>`)
    }
  }
  const minuteStep = tMax > 2400 ? 600 : 300
  for (let t = minuteStep; t < tMax - 1; t += minuteStep) {
    const xx = f1(x(t))
    grid.push(`<line class="hgrid v" x1="${xx}" x2="${xx}" y1="${plot.t}" y2="${H - plot.b}"/>`)
    grid.push(`<text class="htick num" x="${xx}" y="${H - 7}" text-anchor="middle">${formatClock(t)}</text>`)
  }
  grid.push(`<text class="htick num" x="${plot.l}" y="${H - 7}" text-anchor="start">0:00</text>`)
  grid.push(`<text class="htick num" x="${W - plot.r}" y="${H - 7}" text-anchor="end">${formatClock(tMax)}</text>`)

  // 목표선과 목표 대비 띠
  let bands = ''
  let targetPath = ''
  if (targetLine.length) {
    targetPath = `<path class="hcurve-target" d="M${targetLine.map(p => `${f1(x(p.t))},${f1(y(p.split))}`).join(' L')}"/>`
    const tv = points.map(p => p.target!)
    const fastTop = points.map((p, i) => `${f1(p.x)},${f1(y(Math.min(p.split, tv[i]!)))}`)
    const slowBottom = points.map((p, i) => `${f1(p.x)},${f1(y(Math.max(p.split, tv[i]!)))}`)
    const along = points.map((p, i) => `${f1(p.x)},${f1(y(tv[i]!))}`)
    bands = `<path class="hband fast" d="M${fastTop.join(' L')} L${[...along].reverse().join(' L')} Z"/>
      <path class="hband slow" d="M${along.join(' L')} L${[...slowBottom].reverse().join(' L')} Z"/>`
  } else {
    const base = f1(H - plot.b)
    bands = `<path class="hband wash" d="M${points.map(p => `${f1(p.x)},${f1(p.y)}`).join(' L')} L${f1(points[points.length - 1]!.x)},${base} L${f1(points[0]!.x)},${base} Z"/>`
  }

  const line = `<path class="hcurve-line" d="M${points.map(p => `${f1(p.x)},${f1(p.y)}`).join(' L')}"/>`
  const best = points.reduce((a, b) => (b.split < a.split ? b : a))
  const last = points[points.length - 1]!
  const labelY = best.y - 10 < plot.t + 8 ? best.y + 16 : best.y - 9
  const marks = `<circle class="hdot" cx="${f1(best.x)}" cy="${f1(best.y)}" r="4"/>
    <text class="hlabel num" x="${f1(best.x)}" y="${f1(labelY)}" text-anchor="middle">${formatSplit(best.split)}</text>
    <circle class="hdot" cx="${f1(last.x)}" cy="${f1(last.y)}" r="4"/>`

  const legend = `<div class="hlegend"><span><i class="me"></i>내 스플릿</span>${hasTarget ? '<span><i class="tg"></i>목표</span>' : ''}<span class="hint">위가 빠름</span></div>`
  const rows = points.map(p => `<tr><td>${formatClock(p.t)}</td><td>${formatSplit(p.split)}</td><td>${p.target === null ? '—' : formatSplit(p.target)}</td><td>${p.target === null ? '—' : signedSeconds(p.split - p.target)}</td></tr>`).join('')
  const table = `<details class="htable"><summary>표로 보기</summary><table><thead><tr><th>시각</th><th>스플릿</th><th>목표</th><th>차이</th></tr></thead><tbody>${rows}</tbody></table></details>`

  const html = `<div class="hchart" style="height:${H}px">
    <svg class="hcurve" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="스플릿 추이">
      ${grid.join('')}${bands}${targetPath}${line}${marks}
      <line class="hx" id="${o.id}-hx" x1="0" x2="0" y1="${plot.t}" y2="${H - plot.b}" style="display:none"/>
    </svg><div class="htip num" id="${o.id}-tip" hidden></div></div>${legend}${table}`
  return { html, points, plot, tMax, lo, hi, step: domain.step }
}

export function signedSeconds(d: number): string {
  if (!isFinite(d)) return '—'
  if (Math.abs(d) < 0.05) return '±0.0s'
  return `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}s`
}

/**
 * 차트를 호스트에 그리고 십자선·툴팁을 붙인다. 폭을 재야 하므로 호스트가 화면에 보일 때 부른다.
 */
export function renderSplitChart(host: HTMLElement, o: Omit<SplitChartOptions, 'width'>): SplitChartModel | null {
  const model = buildSplitChart({ ...o, width: host.clientWidth || 600 })
  if (!model) {
    host.innerHTML = '<div class="hcurve-cap"><span>곡선을 그릴 기록이 부족합니다</span></div>'
    return null
  }
  host.innerHTML = model.html
  const svg = host.querySelector('svg')!
  const hx = host.querySelector<SVGLineElement>(`#${CSS.escape(o.id)}-hx`)!
  const tip = host.querySelector<HTMLElement>(`#${CSS.escape(o.id)}-tip`)!
  const { plot, tMax, points } = model
  const show = (clientX: number) => {
    const rect = svg.getBoundingClientRect()
    const px = clientX - rect.left
    const t = ((px - plot.l) / (plot.W - plot.l - plot.r)) * tMax
    let best = points[0]!
    for (const p of points) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p
    hx.setAttribute('x1', String(best.x))
    hx.setAttribute('x2', String(best.x))
    hx.style.display = ''
    const delta = best.target === null ? '' : ` · 목표 ${formatSplit(best.target)} (${signedSeconds(best.split - best.target)})`
    tip.textContent = `${formatClock(best.t)} · ${formatSplit(best.split)}${delta}`
    tip.hidden = false
    const flip = best.x > plot.W * 0.6
    tip.style.left = `${best.x}px`
    tip.style.transform = flip ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)'
  }
  svg.addEventListener('pointermove', e => show(e.clientX))
  svg.addEventListener('pointerdown', e => show(e.clientX))
  svg.addEventListener('pointerleave', () => { hx.style.display = 'none'; tip.hidden = true })
  return model
}

/** 비교 칩 — 글자는 잉크색, 방향 글리프가 색을 나른다. upGood=false면 작을수록 좋다(스플릿). */
export function deltaChipHtml(d: number, unit: 'm' | 's', ref: string, upGood = true): string {
  if (!isFinite(d)) return ''
  const dir = d > 0.5 ? 'up' : d < -0.5 ? 'down' : 'flat'
  const good = dir === 'flat' ? 'flat' : (dir === 'up') === upGood ? 'good' : 'bad'
  const glyph = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '●'
  const value = dir === 'flat' ? '같음' : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(unit === 's' ? 1 : 0)}${unit}`
  return `<span class="delta ${good}"><i>${glyph}</i><b class="num">${value}</b><span>${escapeHtml(ref)}</span></span>`
}
