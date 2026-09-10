import { BoatTracker, powerToSpeed, speedToSplit, splitToSpeed } from './physics'
import { StrokeEngine } from './stroke'
import { intensityAt, stepAt, meanIntensityBetween, type StepInfo } from './profile'
import type { WindowStats } from './feedback'
import type { Course } from './courses'
import type { RowerSample } from '../types'
import type { GhostTrack } from './ghost'

/**
 * idle → (카운트다운) → armed → (첫 스트로크) → running → finished
 *
 * armed는 카운트다운이 끝났지만 아직 사용자가 젓지 않은 상태다. 시계·페이스 보트·고스트가
 * 모두 기다린다. 페이스 보트가 먼저 출발해 버리면 "따라잡아라"가 아니라 "이미 늦었다"가 된다.
 */
export type Phase = 'idle' | 'armed' | 'running' | 'finished'

/**
 * 출발 판정.
 *
 * 실기기는 사용자가 가만히 있어도 조용하지 않다. 플라이휠은 5~10초 동안 관성으로 돌며
 * 거리를 더하고 페이스를 서서히 늦추며, PM5 같은 콘솔은 다음 스트로크까지 마지막 값을
 * 그대로 붙들고 보낸다. 그래서 "값이 있다"로는 출발을 판정할 수 없고,
 * "스트로크가 새로 완료됐다" 또는 "속도가 직전보다 빨라졌다"만 출발로 본다.
 * 관성은 느려지기만 하고, 붙든 값은 변하지 않는다.
 */
/** 출발 대기 중 속도로 출발을 인정하려면 최소 이 속도(m/s) 이상이어야 한다 (8:20/500m). */
export const START_SPEED = 1.0
/** ...그리고 직전 샘플보다 이만큼(m/s) 빨라져야 한다. */
export const START_ACCEL = 0.3
/**
 * 카운트다운 마지막 이 시간(ms) 안에 스트로크가 **둘** 완료됐으면 리듬을 타고 있는 것이니 arm 즉시 출발한다.
 * 하나만으로는 안 된다 — "손잡이를 잡으라"는 안내에 시험 삼아 한 번 당겨 보는 사람이 있다.
 */
export const RECENT_STROKE_MS = 4500
/** 출발 대기 중 이만큼(초) 아무 패킷도 없으면 안내를 바꾼다. 가만히 있을 때 조용한 콘솔이 있어 달릴 때(8초)보다 길다. */
export const ARMED_QUIET_AFTER = 20
/** 페이스 보트의 관성 (초). 플레이어 보트(BoatTracker 0.9초)와 같아야 출발선에서 나란히 나간다. */
export const PACE_INERTIA_SEC = 0.9
/**
 * 멈춤 판정은 샘플 수가 아니라 시간으로 한다. 알림 주기가 1~5Hz로 제각각이고,
 * 실시간 파워를 재는 콘솔은 리커버리(최대 2.5초) 동안 정당하게 0을 보낸다.
 */
/** 페이스·파워가 0인 채로 이만큼(ms) 지나면 멈춘 것으로 본다. */
export const STOP_AFTER_ZERO_MS = 2500
/**
 * 거리가 이만큼(ms) 동안 안 늘면, 값을 붙들고 있는 기기(PM5)라도 멈춘 것으로 본다.
 * 스트로크마다 한 번만 거리를 갱신하는 콘솔이 있어, 실제 창은 스트로크 주기의 1.5배까지 늘어난다.
 */
export const STAGNANT_DISTANCE_MS = 4000
/**
 * 그럴듯한 값의 범위. 벗어나면 잘못 파싱된 패킷으로 보고 무시한다.
 * flags 비트를 반대로 해석하는 펌웨어가 있어 거리 바이트가 페이스로 읽히는 일이 실제로 있다.
 */
const PACE_MIN = 60          // 1:00/500m — 세계 기록보다 20초 빠르다
const PACE_MAX = 3000        // 50:00/500m — 이보다 느리면 정보가 아니다 (0xFFFF 센티널 포함)
const POWER_MAX = 1500       // W — 스프린트 피크도 1200을 넘지 않는다

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
  /** 페이스 보트의 현재 속도 (m/s) — 출발 직후엔 0에서 올라온다 */
  paceSpeed: number
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
  /** 페이스·파워가 0인 샘플이 이어지기 시작한 시각 (샘플 at, ms). null이면 지금 0이 아니다 */
  private zeroSince: number | null = null
  /** 직전 샘플이 보고한 속도 (m/s). 정보가 없던 샘플이면 null */
  private lastReportedSpeed: number | null = null
  /** 최근 두 번 strokeCount가 늘어난 샘플의 시각 (ms). [직전, 그 전] */
  private strokeAdvanceTimes: number[] = []
  /**
   * 마지막으로 본 strokeCount / totalDistance.
   * 직전 샘플이 아니라 "그 필드를 실은 마지막 샘플"과 비교해야 한다 — FTMS는 필드가 많으면
   * 알림을 둘로 쪼개 보내서(More Data) 스트로크 필드와 거리 필드가 번갈아 오는 콘솔이 있다.
   */
  private lastStrokeCountSeen: number | null = null
  private lastDistanceChangeAt = 0
  private lastDistanceValue: number | null = null
  /** arm() 시점의 기준값. 이보다 늘어야 출발이다 */
  private armStrokeCount: number | null = null
  private armDistance: number | null = null
  /** 페이스 보트의 현재 속도 (m/s) — 목표 속도로 관성을 갖고 수렴한다 */
  paceSpeed = 0
  /** 거리가 멈춰 정지로 확정된 뒤, 새 이동 증거가 올 때까지 붙든 페이스 값을 무시한다. */
  private stoppedForStagnation = false

  constructor(
    public course: Course,
    /** 기준 500m 스플릿 (초). 구간 강도가 여기에 곱해진다. */
    public baseSplit: number,
    /** 이 코스의 지난 최고 기록. 없으면 null. */
    public ghost: GhostTrack | null = null,
    /** 개발용: 날씨 seed를 고정한다. 없으면 매 운동 달라진다. */
    weatherSeed?: string,
  ) {
    this.weatherSeed = weatherSeed ?? `${course.id}:${Date.now()}:${Math.random()}`
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
    this.zeroSince = null
    this.armStrokeCount = null
    this.armDistance = null
    this.paceSpeed = 0
    this.stoppedForStagnation = false
  }

  /**
   * 카운트다운이 끝났다. 첫 스트로크가 들어올 때까지 시계·페이스 보트·고스트가 기다린다.
   * 카운트다운 마지막 몇 초 안에 스트로크를 완료했다면 이미 젓는 중이니 바로 출발한다.
   * (붙들고 있는 옛 페이스 값이나 관성으로 도는 플라이휠은 출발 근거가 아니다.)
   */
  arm() {
    this.start()
    this.phase = 'armed'
    const last = this.lastSample
    this.armStrokeCount = this.lastStrokeCountSeen
    this.armDistance = this.lastDistanceValue
    const [a, b] = this.strokeAdvanceTimes
    if (last && a !== undefined && b !== undefined && last.at - b <= RECENT_STROKE_MS) {
      this.launch(last)
    }
  }

  /** 출발 대기 중인지 */
  get waitingForStroke() { return this.phase === 'armed' }

  finish() { this.phase = 'finished' }

  /**
   * 첫 스트로크가 들어왔다. 출발선은 지금 이 샘플의 기기 거리다.
   * 대기 중에는 보트를 0에 붙들어 뒀으므로 출발 순간 화면이 튀지 않는다.
   */
  private launch(s: RowerSample) {
    this.phase = 'running'
    this.boat.reset()
    this.boat.onSample(s.totalDistance ?? null, 0)
    if (this.armStrokeCount !== null) this.startStrokeCount = this.armStrokeCount
  }

  /**
   * 샘플이 말하는 속도. 페이스가 있으면 페이스, 없으면 파워에서. 둘 다 없거나
   * 값이 그럴듯하지 않으면(잘못 파싱된 패킷, 0xFFFF 센티널) null.
   */
  private sampleSpeed(s: RowerSample): number | null {
    const pace = s.instantaneousPace
    if (pace !== undefined && pace >= PACE_MIN && pace <= PACE_MAX) return splitToSpeed(pace)
    // 페이스가 없거나 못 믿을 값(0xFFFF '없음' 센티널 포함)이면 파워로 넘어간다
    const power = s.instantaneousPower
    if (power !== undefined && power > 0 && power <= POWER_MAX) return powerToSpeed(power)
    return null
  }

  /**
   * 기기가 속도를 명시적으로 "없음"이라고 말했는지 — 보내는 필드는 전부 0(또는 0xFFFF)이고, 하나는 보냈다.
   * 0xFFFF는 uint16 페이스의 '무한대'라 DIY·오픈소스 펌웨어가 대기 중에 흔히 보낸다.
   */
  private reportsZero(s: RowerSample) {
    const pace = s.instantaneousPace
    const paceZero = pace === undefined || pace === 0 || pace > PACE_MAX
    const powerZero = s.instantaneousPower === undefined || s.instantaneousPower === 0
    const any = pace !== undefined || s.instantaneousPower !== undefined
    return any && paceZero && powerZero
  }

  /**
   * 대기 중에 이 샘플이 '젓기 시작했다'를 뜻하는지.
   * 1) arm 이후 스트로크가 완료됐다 — 가장 믿을 만하다 (FTMS 로어는 거의 다 strokeCount를 준다)
   * 2) 속도가 직전보다 확실히 빨라졌다 — 관성은 느려지기만 하고 붙든 값은 그대로다
   * 3) 스트로크도 속도도 안 주는 기기: 거리가 기준보다 2m 넘게 늘었다
   */
  private startsRowing(s: RowerSample, reported: number | null) {
    if (s.strokeCount !== undefined) {
      if (this.armStrokeCount === null || s.strokeCount < this.armStrokeCount) {
        // 기준이 없거나 콘솔이 카운터를 리셋했다 — 여기서부터 기준을 다시 잡는다
        this.armStrokeCount = s.strokeCount
      } else if (s.strokeCount > this.armStrokeCount) {
        return true
      }
    }
    // 직전 속도가 없으면(카운트다운 내내 조용했던 콘솔) 첫 속도가 곧 첫 스트로크다.
    // 붙든 값과 관성은 어차피 대기 중에 직전 속도를 남기므로 이 예외에 걸리지 않는다.
    if (
      reported !== null && reported >= START_SPEED
      && (this.lastReportedSpeed === null || reported > this.lastReportedSpeed + START_ACCEL)
    ) return true
    if (s.strokeCount === undefined && reported === null && s.totalDistance !== undefined) {
      if (this.armDistance === null || s.totalDistance < this.armDistance - 5) {
        // 콘솔이 새 운동을 시작하며 누적 거리를 0으로 되돌렸다. 옛 기준을 붙들고 있으면
        // 거리만 주는 기기는 이전 누적거리까지 다시 갈 때까지 영원히 출발하지 못한다.
        this.armDistance = s.totalDistance
      }
      else if (s.totalDistance >= this.armDistance + 2) return true
    }
    return false
  }

  /** BLE 연결 상태를 알려준다. 끊겨 있으면 세션 시계가 멈춘다. */
  setLinkDown(down: boolean) { this.linkDown = down }

  /**
   * 데이터가 안 들어와 세션이 멈춰야 하는 상태인지.
   *
   * 연결이 끊긴 경우와, 연결은 살아있는데 패킷이 끊긴 경우 둘 다 잡는다.
   * 후자는 GATT는 유지되는데 알림만 죽는 실제 BLE 실패 모드다.
   */
  get stallReason(): StallReason {
    // 출발 대기 중에도 연결이 끊긴 건 알려야 한다 — 안 그러면 죽은 연결에 대고 노를 젓는다.
    // 데이터 없음은 대기 중엔 한동안 정상일 수 있어(가만히 있으면 조용한 콘솔) 훨씬 길게 기다린다.
    // GATT는 살아 있는데 알림만 죽는 실제 BLE 실패는 그래도 잡아야 한다.
    if (this.phase === 'armed') {
      if (this.linkDown) return 'link'
      if (this.sinceSample > ARMED_QUIET_AFTER) return 'nodata'
      return null
    }
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

    // 스트로크 완료와 거리 변화는 "아직 움직인다"의 증거다 — 멈춤 판정을 막고 출발 판정을 연다.
    // 비교 상대는 직전 샘플이 아니라 그 필드를 실은 마지막 샘플이다 (분할 알림 콘솔).
    const strokeAdvanced = s.strokeCount !== undefined
      && this.lastStrokeCountSeen !== null && s.strokeCount > this.lastStrokeCountSeen
    if (s.strokeCount !== undefined) this.lastStrokeCountSeen = s.strokeCount
    if (strokeAdvanced) this.strokeAdvanceTimes = [s.at, this.strokeAdvanceTimes[0] ?? -Infinity]
    const distanceAdvanced = s.totalDistance !== undefined
      && this.lastDistanceValue !== null && s.totalDistance > this.lastDistanceValue
    if (strokeAdvanced || distanceAdvanced) {
      this.zeroSince = null
      this.stoppedForStagnation = false
    }
    if (s.totalDistance !== undefined && s.totalDistance !== this.lastDistanceValue) {
      this.lastDistanceValue = s.totalDistance
      this.lastDistanceChangeAt = s.at
    }

    this.stroke.onSample(s.strokeRate, s.strokeCount, s.at, strokeAdvanced || distanceAdvanced)

    if (s.strokeCount !== undefined && this.startStrokeCount === null) {
      this.startStrokeCount = s.strokeCount
    }

    const reported = this.sampleSpeed(s)
    if (
      this.stoppedForStagnation && reported !== null && this.lastReportedSpeed !== null
      && reported > this.lastReportedSpeed + START_ACCEL
    ) {
      // 거리/카운트 패킷보다 새 페이스가 먼저 오는 분할 알림도 있다. 붙든 값과 달리
      // 확실히 빨라진 속도는 다시 젓기 시작했다는 증거이므로 정지 latch를 푼다.
      this.stoppedForStagnation = false
    }
    let speed: number
    let explicitlyStopped = false
    if (reported !== null) {
      speed = reported
      this.zeroSince = null
    } else if (this.reportsZero(s) && !strokeAdvanced && !distanceAdvanced) {
      // 기기가 명시적으로 "0"이라고 말했다. 충분히 오래 이어지면 정말 멈춘 것이다.
      // 예전엔 이 경우 마지막 속도를 그대로 유지해서 노를 놓아도 배가 영원히 미끄러졌다.
      this.zeroSince ??= s.at
      explicitlyStopped = s.at - this.zeroSince >= STOP_AFTER_ZERO_MS
      speed = explicitlyStopped ? 0 : this.boat.speed
    } else {
      // 페이스·파워를 안 실은 패킷(분할 알림)이거나 값이 이상한 경우 — 아는 게 없으니 유지한다.
      // zeroSince는 건드리지 않는다: 0을 실은 패킷과 안 실은 패킷이 번갈아 와도 0은 이어지는 중이다.
      speed = this.boat.speed
    }
    // 마지막 값을 붙들고 보내는 기기(PM5)는 0을 보내지 않는다. 거리가 멈춘 게 유일한 신호다.
    // 스트로크마다 한 번만 거리를 갱신하는 콘솔은 스트로크 주기만큼 기다려 준다.
    const strokeWindow = this.stroke.spm > 1 ? 1.5 * 60000 / this.stroke.spm : STAGNANT_DISTANCE_MS
    const stagnantWindow = Math.max(STAGNANT_DISTANCE_MS, strokeWindow)
    const lastStroke = this.strokeAdvanceTimes[0]
    if (
      this.phase === 'running'
      && s.totalDistance !== undefined && this.lastDistanceValue !== null && !strokeAdvanced
      && s.at - this.lastDistanceChangeAt >= stagnantWindow
      && (lastStroke === undefined || s.at - lastStroke >= stagnantWindow)
      && this.boat.speed > 0.05
    ) {
      this.stoppedForStagnation = true
    }
    if (this.stoppedForStagnation) speed = 0
    if (explicitlyStopped || this.stoppedForStagnation) {
      this.stroke.coast()
      this.lastPower = 0
    } else if (s.instantaneousPower !== undefined) {
      this.lastPower = s.instantaneousPower
    }

    if (this.phase === 'armed') {
      if (this.startsRowing(s, reported)) {
        this.launch(s)
        this.boat.onSample(s.totalDistance ?? null, speed)
      } else {
        // 대기 중엔 보트를 출발선에 붙들어 둔다 — 관성으로 도는 플라이휠 때문에 풍경이 흐르면 안 된다
        this.boat.onSample(null, 0)
      }
    } else {
      this.boat.onSample(s.totalDistance ?? null, speed)
    }
    this.lastReportedSpeed = reported !== null ? reported : this.reportsZero(s) ? 0 : this.lastReportedSpeed
  }

  update(dt: number) {
    this.stroke.update(dt)

    if (this.phase !== 'running') {
      // 대기 중에도 조용한 시간은 센다 — 알림이 죽은 연결을 알아채야 한다
      if (this.phase === 'armed') this.sinceSample += dt
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
    // 페이스 보트는 구간 강도에 따라 빨라졌다 느려진다. 플레이어 보트와 같은 관성으로 출발선에서
    // 함께 가속한다 — 한 프레임에 전속력이면 첫 스트로크부터 3m 뒤진 채 시작하게 된다.
    const paceTarget = splitToSpeed(this.baseSplit) * this.intensity
    this.paceSpeed += (paceTarget - this.paceSpeed) * (1 - Math.exp(-dt / PACE_INERTIA_SEC))
    this.paceDistance += this.paceSpeed * dt

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
      paceSpeed: this.paceSpeed,
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
