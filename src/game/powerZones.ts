import { intensityAt, type PaceProfile } from './profile'
import { splitToSpeed } from './physics'
import { range, seededRandom } from './random'

/**
 * 파워 구간 — 코스 중간중간 지나가는 30초짜리 "전력 표지".
 *
 * 긴 스테디 코스의 중반은 지루하다. 몇 분마다 한 번 30초 동안만 목표보다 3초 빠르게 저으면 성공이고,
 * 성공하면 코인과 함성이 따라온다. 회복 구간(강도 0.95 미만)에는 두지 않는다 — 쉬라는 구간에서 전력을 시키면 코스 설계와 싸운다.
 * 구간 시각은 seed에서 나오므로 `?weather=seed`로 같은 레이스를 재현할 수 있다.
 *
 * 성공 판정은 구간 평균 스플릿을 그 30초 동안 페이스 보트가 낸 평균 스플릿과 비교한다 (적분끼리 비교 — 램프 중이어도 공평하다).
 */
export const ZONE_SEC = 30
/** 첫 구간은 출발 뒤 이 범위(초)에서 */
export const ZONE_FIRST_MIN = 150
export const ZONE_FIRST_MAX = 240
/** 다음 구간까지 간격 (초) */
export const ZONE_GAP_MIN = 210
export const ZONE_GAP_MAX = 330
/** 코스 끝 이만큼(초) 안에는 두지 않는다 — 곧 요약이 뜬다 */
export const ZONE_TAIL_SEC = 75
/** 시작 몇 초 전에 예고하는지 */
export const ZONE_WARN_SEC = 10
/** 목표보다 이만큼(초/500m) 빨라야 성공 */
export const ZONE_SUCCESS_MARGIN = 3
/** 이 강도 미만(회복 구간)에는 두지 않는다 */
export const ZONE_MIN_INTENSITY = 0.95

export interface PowerZone {
  index: number
  start: number
  end: number
}

export type ZoneEvent =
  | { kind: 'zone-soon'; zone: PowerZone; startsIn: number }
  | { kind: 'zone-start'; zone: PowerZone }
  | { kind: 'zone-end'; zone: PowerZone; success: boolean; avgSplit: number; targetSplit: number; deltaSec: number }

export interface ZoneView {
  zone: PowerZone
  state: 'soon' | 'active'
  /** 시작까지(soon) 또는 끝까지(active) 남은 초 */
  remaining: number
  /** active일 때 0..1 */
  progress: number
  /** active일 때 지금까지의 구간 평균 스플릿 (초/500m). 아직 거리가 없으면 Infinity */
  avgSplit: number
  /** 구간에서 페이스 보트가 낸 평균 스플릿 */
  targetSplit: number
  /** avgSplit − targetSplit. 음수면 앞선다 */
  delta: number
}

/** 코스 프로파일과 seed로 파워 구간 목록을 만든다. 회복 구간에 걸리면 15초씩 뒤로 민다. */
export function createPowerZones(seed: string, profile: PaceProfile, durationSec: number): PowerZone[] {
  const random = seededRandom(`${seed}:power-zones`)
  const zones: PowerZone[] = []
  let t = range(random, ZONE_FIRST_MIN, ZONE_FIRST_MAX)
  while (t + ZONE_SEC <= durationSec - ZONE_TAIL_SEC) {
    let start = t
    let tries = 0
    while (
      tries < 24
      && (intensityAt(profile, start) < ZONE_MIN_INTENSITY || intensityAt(profile, start + ZONE_SEC) < ZONE_MIN_INTENSITY)
    ) {
      start += 15
      tries++
    }
    if (start + ZONE_SEC > durationSec - ZONE_TAIL_SEC) break
    if (tries < 24) zones.push({ index: zones.length, start, end: start + ZONE_SEC })
    t = start + ZONE_SEC + range(random, ZONE_GAP_MIN, ZONE_GAP_MAX)
  }
  return zones
}

export class PowerZoneTracker {
  /** 끝난 구간 수와 성공 수 */
  attempted = 0
  successes = 0
  private next = 0
  private warned = false
  private active: PowerZone | null = null
  private startElapsed = 0
  private startDistance = 0
  /** 구간 동안 페이스 보트가 간 거리 (m) — 목표 스플릿 적분 */
  private paceMeters = 0
  private lastElapsed: number | null = null

  constructor(readonly zones: readonly PowerZone[]) {}

  /**
   * @param elapsed     세션 시계 (초)
   * @param distance    내 거리 (m)
   * @param targetSplit 지금 코스가 요구하는 스플릿 (초/500m)
   */
  update(elapsed: number, distance: number, targetSplit: number): ZoneEvent[] {
    const events: ZoneEvent[] = []
    const dt = this.lastElapsed === null ? 0 : Math.max(0, elapsed - this.lastElapsed)
    this.lastElapsed = elapsed

    if (this.active) {
      this.paceMeters += splitToSpeed(targetSplit) * dt
      if (elapsed >= this.active.end) {
        const zone = this.active
        const seconds = Math.max(1e-3, elapsed - this.startElapsed)
        const meters = distance - this.startDistance
        const avgSplit = meters > 0 ? (seconds / meters) * 500 : Infinity
        const target = this.paceMeters > 0 ? (seconds / this.paceMeters) * 500 : targetSplit
        const deltaSec = avgSplit - target
        const success = isFinite(avgSplit) && deltaSec <= -ZONE_SUCCESS_MARGIN
        this.attempted++
        if (success) this.successes++
        this.active = null
        this.next = zone.index + 1
        this.warned = false
        events.push({ kind: 'zone-end', zone, success, avgSplit, targetSplit: target, deltaSec })
      }
      return events
    }

    const zone = this.zones[this.next]
    if (!zone) return events
    if (!this.warned && elapsed >= zone.start - ZONE_WARN_SEC && elapsed < zone.start) {
      this.warned = true
      events.push({ kind: 'zone-soon', zone, startsIn: zone.start - elapsed })
    }
    if (elapsed >= zone.start) {
      // 늦게 따라잡은 경우(멈춤 뒤) 이미 끝난 구간은 건너뛴다
      if (elapsed >= zone.end) {
        this.next = zone.index + 1
        this.warned = false
        return this.update(elapsed, distance, targetSplit)
      }
      this.active = zone
      this.startElapsed = elapsed
      this.startDistance = distance
      this.paceMeters = 0
      events.push({ kind: 'zone-start', zone })
    }
    return events
  }

  view(elapsed: number, distance: number, targetSplit: number): ZoneView | null {
    if (this.active) {
      const seconds = Math.max(0, elapsed - this.startElapsed)
      const meters = distance - this.startDistance
      const avgSplit = meters > 0 && seconds > 0 ? (seconds / meters) * 500 : Infinity
      const target = this.paceMeters > 0 && seconds > 0 ? (seconds / this.paceMeters) * 500 : targetSplit
      return {
        zone: this.active, state: 'active',
        remaining: Math.max(0, this.active.end - elapsed),
        progress: Math.min(1, seconds / ZONE_SEC),
        avgSplit, targetSplit: target, delta: avgSplit - target,
      }
    }
    const zone = this.zones[this.next]
    if (zone && elapsed >= zone.start - ZONE_WARN_SEC && elapsed < zone.start) {
      return {
        zone, state: 'soon', remaining: zone.start - elapsed, progress: 0,
        avgSplit: Infinity, targetSplit, delta: Infinity,
      }
    }
    return null
  }

  /** 다음 구간 시작까지 (초). 없으면 null */
  nextStartsIn(elapsed: number): number | null {
    if (this.active) return 0
    const zone = this.zones[this.next]
    return zone ? Math.max(0, zone.start - elapsed) : null
  }
}
