/**
 * "이 속도는 지켜야 한다" 게이지의 순수 계산.
 *
 * 목표 페이스를 막대 위 고정된 선으로 두고, 지금 페이스를 채워지는 막대로 보여준다.
 * 막대는 목표보다 25초 느린 곳이 왼쪽 끝, 15초 빠른 곳이 오른쪽 끝이라
 * 목표 선은 항상 같은 자리(62.5%)에 있고 막대만 움직인다.
 */
const GAUGE_SLOW_SPAN = 25
const GAUGE_FAST_SPAN = 15
/** 이 안이면 '유지 중'으로 본다 (초) */
const GAUGE_TOLERANCE = 2

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
