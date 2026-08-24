import type { RowerSample, RowerSource, SourceStatus } from '../types'
import { splitToPower, powerToSpeed, speedToSplit } from '../game/physics'

/**
 * 로잉머신 시뮬레이터.
 *
 * 실기기 없이 개발하려면 필수다. FtmsSource와 같은 인터페이스라 게임 코드는 차이를 모른다.
 * 실기기처럼 2Hz로만 샘플을 내보내서, 보간/외삽 로직이 제대로 도는지도 같이 검증된다.
 */
export class MockSource implements RowerSource {
  readonly name = '시뮬레이터'
  status: SourceStatus = 'idle'

  /** 0~1. UI 슬라이더로 조절해서 아바타 반응을 확인한다. */
  intensity = 0.55

  private timer: number | null = null
  private sampleFns = new Set<(s: RowerSample) => void>()
  private statusFns = new Set<(s: SourceStatus, d?: string) => void>()

  private distance = 0
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

  private reset() {
    this.distance = 0; this.strokeCount = 0; this.strokePhase = 0
    this.elapsed = 0; this.energy = 0
  }

  private tick() {
    const now = performance.now()
    const dt = Math.min(1, (now - this.lastAt) / 1000)
    this.lastAt = now
    this.elapsed += dt

    // 강도 → 목표 스플릿 (2:50 ~ 1:50). 사람처럼 약간의 흔들림을 준다.
    const wobble = Math.sin(this.elapsed * 0.31) * 2.5 + Math.sin(this.elapsed * 1.7) * 1.2
    const split = 170 - this.intensity * 60 + wobble
    const power = splitToPower(split)
    const speed = powerToSpeed(power)

    this.distance += speed * dt
    this.energy += (power * dt) / 4184 * 4  // 아주 대략적인 kcal 환산

    // 스트로크 레이트도 강도에 연동 (18 ~ 34 spm)
    const spm = 18 + this.intensity * 16 + Math.sin(this.elapsed * 0.5) * 1.0
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
      instantaneousPace: Math.round(speedToSplit(speed)),
      instantaneousPower: Math.round(power),
      totalEnergy: Math.floor(this.energy),
      heartRate: Math.round(105 + this.intensity * 60 + Math.sin(this.elapsed * 0.2) * 4),
      elapsedTime: Math.floor(this.elapsed),
    }
    for (const fn of this.sampleFns) fn(sample)
  }
}
