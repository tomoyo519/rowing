import type { RowerSample, RowerSource, SourceStatus } from '../types'
import { splitToPower, powerToSpeed, speedToSplit } from '../game/physics'

/**
 * 로잉머신 시뮬레이터.
 *
 * 실기기 없이 개발하려면 필수다. FtmsSource와 같은 인터페이스라 게임 코드는 차이를 모른다.
 * 실기기처럼 2Hz로만 샘플을 내보내서, 보간/외삽 로직이 제대로 도는지도 같이 검증된다.
 */
/** 노를 놓은 뒤 플라이휠이 느려지는 시간 상수 (초). 실기기는 5~10초 돈다 */
const FLYWHEEL_TAU = 2.2

export class MockSource implements RowerSource {
  readonly name = '시뮬레이터'
  status: SourceStatus = 'idle'

  /** 0~1. UI 슬라이더로 조절해서 아바타 반응을 확인한다. */
  intensity = 0.55

  private timer: number | null = null
  private sampleFns = new Set<(s: RowerSample) => void>()
  private statusFns = new Set<(s: SourceStatus, d?: string) => void>()

  private distance = 0
  /** 플라이휠 속도 (m/s 환산). 노를 놓으면 관성으로 서서히 준다 */
  private wheel = 0
  private strokeCount = 0
  private strokePhase = 0
  private elapsed = 0
  private energy = 0
  private lastAt = 0

  async connect(): Promise<void> {
    this.reset()
    this.lastAt = performance.now()
    // 실기기와 같은 2Hz
    this.timer = window.setInterval(() => this.tick(), 500)
    this.status = 'connected'
    for (const fn of this.statusFns) fn('connected', '시뮬레이터')
  }

  async disconnect(): Promise<void> {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    this.status = 'disconnected'
    for (const fn of this.statusFns) fn('disconnected')
  }

  onSample(fn: (s: RowerSample) => void) {
    this.sampleFns.add(fn)
    return () => this.sampleFns.delete(fn)
  }

  onStatus(fn: (s: SourceStatus, d?: string) => void) {
    this.statusFns.add(fn)
    return () => this.statusFns.delete(fn)
  }

  /**
   * 개발용: 연결이 끊겼다 돌아오는 상황을 재현한다.
   * 실기기 없이 끊김 배너·세션 일시정지·재연결 복귀를 확인할 수 있다.
   */
  simulateDropout(ms = 7000) {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    this.status = 'reconnecting'
    for (const fn of this.statusFns) fn('reconnecting', '시뮬레이터')

    window.setTimeout(() => {
      this.lastAt = performance.now()
      this.timer = window.setInterval(() => this.tick(), 500)
      this.status = 'connected'
      for (const fn of this.statusFns) fn('connected', '시뮬레이터')
    }, ms)
  }

  private reset() {
    this.distance = 0; this.wheel = 0; this.strokeCount = 0; this.strokePhase = 0
    this.elapsed = 0; this.energy = 0
  }

  private tick() {
    const now = performance.now()
    const dt = Math.min(1, (now - this.lastAt) / 1000)
    this.lastAt = now
    this.elapsed += dt

    // 슬라이더 맨 왼쪽 = 노를 놓은 상태.
    // 실기기처럼 플라이휠이 몇 초 관성으로 돌며 거리를 더하고 페이스가 서서히 늦어진 뒤에야 0이 된다.
    // 출발 판정이 관성에 속지 않는지, 멈춤 판정이 제때 되는지 실기기 없이 확인하는 데 쓴다.
    const stopped = this.intensity < 0.02

    // 강도 → 목표 스플릿 (2:50 ~ 1:50). 사람처럼 약간의 흔들림을 준다.
    const wobble = Math.sin(this.elapsed * 0.31) * 2.5 + Math.sin(this.elapsed * 1.7) * 1.2
    const split = 170 - this.intensity * 60 + wobble
    if (stopped) this.wheel *= Math.exp(-dt / FLYWHEEL_TAU)
    else this.wheel = powerToSpeed(splitToPower(split))
    const coasting = stopped && this.wheel > 0.3
    const speed = stopped ? (coasting ? this.wheel : 0) : this.wheel
    const power = stopped ? 0 : splitToPower(split)

    this.distance += speed * dt
    this.energy += (power * dt) / 4184 * 4  // 아주 대략적인 kcal 환산

    // 스트로크 레이트도 강도에 연동 (18 ~ 34 spm)
    const spm = stopped ? 0 : 18 + this.intensity * 16 + Math.sin(this.elapsed * 0.5) * 1.0
    this.strokePhase += (spm / 60) * dt
    while (this.strokePhase >= 1) {
      this.strokePhase -= 1
      this.strokeCount += 1
    }

    const sample: RowerSample = {
      at: now,
      strokeRate: Math.round(spm * 2) / 2,           // 실기기처럼 0.5 단위로 양자화
      strokeCount: this.strokeCount,
      totalDistance: Math.floor(this.distance),      // 실기기처럼 정수 미터
      instantaneousPace: speed > 0 ? Math.round(speedToSplit(speed)) : 0,
      instantaneousPower: Math.round(power),
      totalEnergy: Math.floor(this.energy),
      heartRate: Math.round(105 + this.intensity * 60 + Math.sin(this.elapsed * 0.2) * 4),
      elapsedTime: Math.floor(this.elapsed),
    }
    for (const fn of this.sampleFns) fn(sample)
  }
}
