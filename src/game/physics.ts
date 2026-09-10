/**
 * Concept2 표준 관계식: P = 2.80 / t³  (t = 초/미터)
 * 실내 로잉계에서 파워↔페이스 변환의 사실상 표준이라 이걸 쓴다.
 */
export const C2_K = 2.80

/** watts → m/s */
export function powerToSpeed(watts: number): number {
  if (watts <= 0) return 0
  return Math.cbrt(watts / C2_K)
}

/** m/s → 500m 스플릿(초) */
export function speedToSplit(mps: number): number {
  return mps > 0.05 ? 500 / mps : Infinity
}

/** 500m 스플릿(초) → m/s */
export function splitToSpeed(split: number): number {
  return split > 0 ? 500 / split : 0
}

/** 500m 스플릿(초) → watts */
export function splitToPower(split: number): number {
  const t = split / 500
  return t > 0 ? C2_K / (t * t * t) : 0
}

export function formatSplit(sec: number): string {
  // 출발 직후처럼 속도가 거의 0이면 8:17 같은 숫자가 뜨는데, 읽을 값이 아니다
  if (!isFinite(sec) || sec <= 0 || sec > 600) return '--:--'
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

/** 페이스 티어 라벨용 — 소수점 없이 mm:ss */
export function formatSplitShort(sec: number): string {
  // 거의 멈춘 속도에서 나오는 138:53 같은 숫자는 페이스가 아니다
  if (!isFinite(sec) || sec <= 0 || sec > 600) return '--:--'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec - m * 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatClock(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '00:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec - m * 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * 보트 위치 추정기.
 *
 * FTMS notification은 1~2Hz로만 오는데 화면은 60fps다. 그 사이를 속도로 외삽(dead reckoning)하고,
 * 새 패킷이 오면 기기가 보고한 거리 쪽으로 부드럽게 수렴시킨다.
 * 기기 거리를 그대로 쓰면 뚝뚝 끊기고, 순수 적분만 하면 실제 머신과 어긋난다.
 */
export class BoatTracker {
  /** 화면에 그릴 거리 (m) */
  distance = 0
  /** 현재 속도 (m/s) */
  speed = 0

  private deviceDistance: number | null = null
  private targetSpeed = 0
  /**
   * 세션 시작 시점의 기기 누적 거리.
   * 로잉머신의 totalDistance는 전원을 켠 뒤로 계속 쌓이므로 그대로 쓰면
   * 레이스를 시작하자마자 거리가 그 값으로 점프한다. 시작 시점을 0으로 잡아야 한다.
   */
  private origin: number | null = null
  /** 마지막 패킷 이후 흐른 시간 (초) — 외삽에 쓴다 */
  private sinceSample = 0

  /** 새 샘플 수신. 기기가 거리를 안 주면 null을 넘기면 된다. */
  onSample(deviceDistance: number | null, speed: number) {
    this.targetSpeed = speed
    if (deviceDistance === null) return

    if (this.origin === null) {
      this.origin = deviceDistance
      this.deviceDistance = 0
      this.distance = 0
    } else {
      const relative = deviceDistance - this.origin
      if (this.deviceDistance !== null && relative < this.deviceDistance - 5) {
        // 콘솔이 새 운동을 시작해 누적 거리를 리셋했다. 화면 위치를 그대로 이어가도록 기준만 옮긴다.
        this.origin = deviceDistance - this.deviceDistance
      } else {
        this.deviceDistance = relative
      }
    }
    this.sinceSample = 0
  }

  /** 매 프레임 호출. dt 단위는 초. */
  update(dt: number) {
    // 보트 관성: 목표 속도로 지수 수렴 (dt에 무관하게 안정적)
    this.speed += (this.targetSpeed - this.speed) * (1 - Math.exp(-dt / 0.9))
    this.sinceSample += dt

    if (this.deviceDistance === null) {
      this.distance += this.speed * dt
      return
    }

    // 마지막 패킷 이후 흐른 시간만큼 외삽한 값이 '지금 있어야 할 위치'다.
    // 패킷 값을 그대로 쫓아가면 항상 그만큼 뒤처지므로 반드시 외삽분을 포함해야 한다.
    const target = this.deviceDistance + this.speed * this.sinceSample
    const err = target - this.distance

    if (Math.abs(err) > 25) {
      this.distance = target            // 재연결 등으로 크게 벌어지면 즉시 스냅
      return
    }
    // 전진분 + 오차 보정. target도 같은 속도로 움직이므로 정상상태 오차가 남지 않는다.
    this.distance += this.speed * dt + err * (1 - Math.exp(-dt / 0.6))
  }

  reset() {
    this.distance = 0
    this.speed = 0
    this.targetSpeed = 0
    this.deviceDistance = null
    this.origin = null
    this.sinceSample = 0
  }
}
