/**
 * "이 속도는 지켜야 한다" 게이지의 순수 계산.
 *
 * 목표 페이스를 막대 위 고정된 선으로 두고, 지금 페이스를 채워지는 막대로 보여준다.
 * 막대는 목표보다 25초 느린 곳이 왼쪽 끝, 15초 빠른 곳이 오른쪽 끝이라
 * 목표 선은 항상 같은 자리(62.5%)에 있고 막대만 움직인다.
 *
 * 화면의 막대는 목표를 **가운데**에 둔 양방향 막대다(paceGaugeBar): 느리면 왼쪽으로 붉게,
 * 빠르면 오른쪽으로 초록으로 자란다. 방향과 크기가 한 번에 읽힌다.
 */
export const GAUGE_SLOW_SPAN = 25
export const GAUGE_FAST_SPAN = 15
/** 이 안이면 '유지 중'으로 본다 (초) */
export const GAUGE_TOLERANCE = 2

export type PaceGaugeState = 'idle' | 'behind' | 'ok' | 'ahead'

export interface PaceGauge {
  /** 0..1 — 막대가 채워진 비율 */
  fill: number
  /** 0..1 — 목표 선의 위치 */
  target: number
  /** 지금 스플릿 - 목표 스플릿 (초). +면 느림. 값이 없으면 Infinity */
  delta: number
  state: PaceGaugeState
}

export function paceGaugeState(split: number, targetSplit: number): PaceGauge {
  const valid = isFinite(split) && split > 0 && split < 600 && isFinite(targetSplit) && targetSplit > 0
  const delta = valid ? split - targetSplit : Infinity
  const span = GAUGE_SLOW_SPAN + GAUGE_FAST_SPAN
  const fill = valid
    ? Math.max(0, Math.min(1, (targetSplit + GAUGE_SLOW_SPAN - split) / span))
    : 0
  const state: PaceGaugeState = !valid
    ? 'idle'
    : delta > GAUGE_TOLERANCE ? 'behind' : delta < -GAUGE_TOLERANCE ? 'ahead' : 'ok'
  return { fill, delta, state, target: GAUGE_SLOW_SPAN / span }
}

/** 양방향 막대의 채움 — 양 끝에서 비워 둘 비율(%). 가운데(50%)가 목표다. */
export interface PaceGaugeBar {
  left: number
  right: number
}

/**
 * 느리면(delta > 0) 가운데에서 왼쪽으로, 빠르면 오른쪽으로 자란다.
 * 왼쪽 절반은 25초, 오른쪽 절반은 15초를 나타낸다 — 빠른 쪽은 여유가 작아 더 민감하게 움직인다.
 */
export function paceGaugeBar(delta: number): PaceGaugeBar {
  if (!isFinite(delta)) return { left: 50, right: 50 }
  if (delta > 0) {
    const w = Math.min(1, delta / GAUGE_SLOW_SPAN) * 50
    return { left: 50 - w, right: 50 }
  }
  const w = Math.min(1, -delta / GAUGE_FAST_SPAN) * 50
  return { left: 50, right: 50 - w }
}

/** 허용 범위(±2초) 띠가 가운데에서 양쪽으로 차지하는 비율(%) */
export function paceGaugeTolerance(): { left: number; right: number } {
  return {
    left: (GAUGE_TOLERANCE / GAUGE_SLOW_SPAN) * 50,
    right: (GAUGE_TOLERANCE / GAUGE_FAST_SPAN) * 50,
  }
}

/** 5초마다 눈금. 왼쪽 끝 −25초, 오른쪽 끝 +15초. pct는 막대 왼쪽 끝 기준 위치(%) */
export function paceGaugeTicks(step = 5): { pct: number; seconds: number }[] {
  const ticks: { pct: number; seconds: number }[] = []
  for (let s = -GAUGE_SLOW_SPAN; s <= GAUGE_FAST_SPAN; s += step) {
    if (s === 0) continue
    const pct = s < 0 ? 50 + (s / GAUGE_SLOW_SPAN) * 50 : 50 + (s / GAUGE_FAST_SPAN) * 50
    ticks.push({ pct, seconds: s })
  }
  return ticks
}
