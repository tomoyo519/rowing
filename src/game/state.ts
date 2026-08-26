import { BoatTracker, powerToSpeed, speedToSplit, splitToSpeed } from './physics'
import { StrokeEngine } from './stroke'
import { intensityAt, stepAt, meanIntensityBetween, type StepInfo } from './profile'
import type { WindowStats } from './feedback'
import type { Course } from './courses'
import type { RowerSample } from '../types'
import type { GhostTrack } from './ghost'

export type Phase = 'idle' | 'running' | 'finished'

export interface Metrics {
  distance: number
  /** 현재 보트 속도 (m/s) */
  speed: number
  elapsed: number
  remaining: number
  split: number
  avgSplit: number
  spm: number
  power: number
  strokeCount: number
  heartRate?: number
  calories?: number
  /** 페이스 보트 대비 거리차 (m). +면 앞서는 중 */
  gap: number
  progress: number
  /** 지금 이 순간 코스가 요구하는 스플릿 (초/500m) */
  targetSplit: number
  /** 현재 구간 이름 + 남은 시간 */
  step: StepInfo
  /** 현재 구간 강도 배율 (1.0 = 기준) */
  intensity: number
  /** 데이터가 안 들어와 세션이 멈춘 상태인지 */
  stalled: boolean
  /** 멈춘 이유 — 배너 문구에 쓴다 */
  stallReason: StallReason
  /** 고스트(지난 최고 기록)가 가 있는 거리 (m). 기록이 없으면 null */
  ghostDistance: number | null
  /** 고스트 대비 거리차 (m). +면 앞서는 중. 기록이 없으면 null */
  ghostGap: number | null
}

export type StallReason = null | 'link' | 'nodata'

/** 이 시간(초) 동안 데이터가 없으면 멈춘 것으로 본다 */
export const STALL_AFTER = 8

export class Session {
  phase: Phase = 'idle'
  readonly boat = new BoatTracker()
  readonly stroke = new StrokeEngine()
  /** 한 운동 안에서는 재현 가능하고, 새 운동을 시작할 때만 달라지는 날씨 seed. */
  readonly weatherSeed: string

  paceDistance = 0
  elapsed = 0

  private lastPower = 0
  private lastSample: RowerSample | null = null
  private startStrokeCount: number | null = null
  readonly track: { t: number; d: number; split: number; spm: number; power: number }[] = []
  private lastTrackAt = -1

  /** 마지막 샘플 이후 흐른 시간 (초) */
  private sinceSample = 0
  /** BLE 연결이 끊긴 상태인지 — 바깥에서 알려준다 */
  private linkDown = false

  constructor(
    public course: Course,
    /** 기준 500m 스플릿 (초). 구간 강도가 여기에 곱해진다. */
    public baseSplit: number,
    /** 이 코스의 지난 최고 기록. 없으면 null. */
    public ghost: GhostTrack | null = null,
  ) {
    this.weatherSeed = `${course.id}:${Date.now()}:${Math.random()}`
  }

  start() {
    this.phase = 'running'
    this.elapsed = 0
    this.paceDistance = 0
    this.lastPower = 0
    this.startStrokeCount = null
    this.track.length = 0
    this.lastTrackAt = -1
    this.boat.reset()
    this.stroke.reset()
    this.sinceSample = 0
  }

  finish() { this.phase = 'finished' }

  /** BLE 연결 상태를 알려준다. 끊겨 있으면 세션 시계가 멈춘다. */
  setLinkDown(down: boolean) { this.linkDown = down }

  /**
   * 데이터가 안 들어와 세션이 멈춰야 하는 상태인지.
   *
   * 연결이 끊긴 경우와, 연결은 살아있는데 패킷이 끊긴 경우 둘 다 잡는다.
   * 후자는 GATT는 유지되는데 알림만 죽는 실제 BLE 실패 모드다.
   */
  get stallReason(): StallReason {
    if (this.phase !== 'running') return null
    if (this.linkDown) return 'link'
    if (this.sinceSample > STALL_AFTER) return 'nodata'
    return null
  }

  /** 지금 코스가 요구하는 속도 배율 */
  get intensity(): number {
    return intensityAt(this.course.profile, this.elapsed)
  }

  onSample(s: RowerSample) {
    this.sinceSample = 0
    this.lastSample = s
    this.stroke.onSample(s.strokeRate, s.strokeCount, s.at)

    if (s.strokeCount !== undefined && this.startStrokeCount === null) {
      this.startStrokeCount = s.strokeCount
    }

    let speed: number
    if (s.instantaneousPace !== undefined && s.instantaneousPace > 0) {
      speed = splitToSpeed(s.instantaneousPace)
    } else if (s.instantaneousPower !== undefined && s.instantaneousPower > 0) {
      speed = powerToSpeed(s.instantaneousPower)
    } else {
      speed = this.boat.speed
    }
    if (s.instantaneousPower !== undefined) this.lastPower = s.instantaneousPower

    this.boat.onSample(s.totalDistance ?? null, speed)
  }

  update(dt: number) {
    this.stroke.update(dt)

    if (this.phase !== 'running') {
      this.boat.update(dt)
      return
    }

    this.sinceSample += dt

    // 데이터가 없으면 시계를 세운다. 젓지 못한 시간을 기록에 넣을 수는 없다.
    // 보트와 아바타는 계속 갱신해서 자연스럽게 멈추도록 둔다.
    if (this.stallReason !== null) {
      this.boat.update(dt)
      return
    }

    this.elapsed += dt
    this.boat.update(dt)
    // 페이스 보트는 구간 강도에 따라 빨라졌다 느려진다
    this.paceDistance += splitToSpeed(this.baseSplit) * this.intensity * dt

    const sec = Math.floor(this.elapsed)
    if (sec !== this.lastTrackAt) {
      this.lastTrackAt = sec
      const m = this.metrics()
      this.track.push({ t: sec, d: m.distance, split: m.split, spm: m.spm, power: m.power })
    }

    if (this.elapsed >= this.course.durationSec) this.finish()
  }

  /** 특정 시점의 구간 이름 — 다음 구간 예고에 쓴다 */
  stepLabelAt(t: number): string {
    return stepAt(this.course.profile, t).label
  }

  /**
   * [from, to] 구간의 실제 성적. 5분 체크포인트 피드백에 쓴다.
   * 기록이 부족하면 null.
   */
  windowStats(from: number, to: number): WindowStats | null {
    const inRange = this.track.filter(x => x.t >= from && x.t <= to)
    if (inRange.length < 5) return null
    const first = inRange[0]!, lastRow = inRange[inRange.length - 1]!
    const seconds = lastRow.t - first.t
    const distance = lastRow.d - first.d
    if (seconds <= 0 || distance <= 0) return null

    const mean = (f: (x: typeof first) => number) =>
      inRange.reduce((a, x) => a + f(x), 0) / inRange.length

    return {
      split: (seconds / distance) * 500,
      targetSplit: this.baseSplit / meanIntensityBetween(this.course.profile, from, to),
      spm: mean(x => x.spm),
      power: mean(x => x.power),
      distance,
      seconds,
    }
  }

  metrics(): Metrics {
    const d = this.boat.distance
    const split = speedToSplit(this.boat.speed)
    const avgSplit = this.elapsed > 0 && d > 0 ? (this.elapsed / d) * 500 : Infinity
    const sc = this.lastSample?.strokeCount
    const intensity = this.intensity
    const ghostDistance = this.ghost ? this.ghost.distanceAt(this.elapsed) : null
    return {
      distance: d,
      speed: this.boat.speed,
      elapsed: this.elapsed,
      remaining: Math.max(0, this.course.durationSec - this.elapsed),
      split,
      avgSplit,
      spm: this.stroke.spm,
      power: this.lastPower,
      strokeCount: sc !== undefined && this.startStrokeCount !== null ? sc - this.startStrokeCount : 0,
      heartRate: this.lastSample?.heartRate,
      calories: this.lastSample?.totalEnergy,
      gap: d - this.paceDistance,
      progress: Math.min(1, this.elapsed / this.course.durationSec),
      targetSplit: this.baseSplit / intensity,
      step: stepAt(this.course.profile, this.elapsed),
      intensity,
      stalled: this.stallReason !== null,
      stallReason: this.stallReason,
      ghostDistance,
      ghostGap: ghostDistance === null ? null : d - ghostDistance,
    }
  }
}
