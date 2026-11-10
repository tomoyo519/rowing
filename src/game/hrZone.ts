/**
 * 심박 존 게이지 — 몸 상태를 게임으로.
 *
 * 목표 존(티어에 따라 Z2~Z4)에 머무는 시간만큼 게이지가 찬다(2분이면 가득). 존보다 낮으면 천천히 빠지고,
 * 존보다 높으면 멈춘다(과하게 올려서 채우는 건 막는다). 가득 차면 10초 '부스트' 연출과 코인, 그리고 다시 0에서.
 * 심박 센서(벨트·시계·기기 FTMS 심박)가 있을 때만 켜진다. 최대 심박은 사용자가 정한다 — 모르면 220 − 나이가 흔한 기준이다.
 */
export const MAX_HR_KEY = 'makeRowing.maxHr.v1'
export const DEFAULT_MAX_HR = 185
export const MAX_HR_MIN = 120
export const MAX_HR_MAX = 230
/** 존 경계 — 최대 심박 대비 비율. Z1 < 60% ≤ Z2 < 70% ≤ Z3 < 80% ≤ Z4 < 90% ≤ Z5 */
export const HR_ZONE_BOUNDS: readonly number[] = [0.6, 0.7, 0.8, 0.9]
export const HRZ_FILL_SEC = 120
export const HRZ_DRAIN_SEC = 60
export const HRZ_BOOST_SEC = 10
/** Z5에 이만큼(초) 이어지면 한 번 경고한다 */
export const HRZ_HIGH_WARN_SEC = 45
/** 경고 사이 최소 간격 (초) */
export const HRZ_HIGH_WARN_GAP = 180

export type HrEvent =
  | { kind: 'hr-boost'; boosts: number }
  | { kind: 'hr-high'; zone: number }

export function hrZoneOf(hr: number, maxHr: number): number {
  const ratio = hr / Math.max(1, maxHr)
  let zone = 1
  for (const bound of HR_ZONE_BOUNDS) if (ratio >= bound) zone++
  return zone
}

/** 티어별 목표 존. 가볍게는 Z2, 스테디·강하게는 Z3, 레이스·전력은 Z4 */
export function targetZoneForTier(tierId: string): number {
  switch (tierId) {
    case 'easy': return 2
    case 'race':
    case 'max': return 4
    default: return 3
  }
}

export const ZONE_LABELS: readonly string[] = ['', '회복', '유산소', '템포', '역치', '최대']

export function loadMaxHr(): number {
  try {
    const n = Number(localStorage.getItem(MAX_HR_KEY))
    return n >= MAX_HR_MIN && n <= MAX_HR_MAX ? Math.round(n) : DEFAULT_MAX_HR
  } catch { return DEFAULT_MAX_HR }
}

export function saveMaxHr(n: number) {
  try { localStorage.setItem(MAX_HR_KEY, String(Math.round(n))) } catch { /* 저장소 미지원 */ }
}

export class HrZoneGauge {
  /** 0..1 */
  fill = 0
  boosts = 0
  boostRemaining = 0
  /** 마지막으로 본 존 (1~5). 심박이 없으면 null */
  zone: number | null = null
  private highSince: number | null = null
  private lastWarnAt = -Infinity
  private elapsed = 0

  constructor(public maxHr = DEFAULT_MAX_HR, public targetZone = 3) {}

  get boosting() { return this.boostRemaining > 0 }

  update(dt: number, hr: number | undefined): HrEvent[] {
    const events: HrEvent[] = []
    this.elapsed += dt
    if (this.boostRemaining > 0) this.boostRemaining = Math.max(0, this.boostRemaining - dt)
    if (hr === undefined || !(hr > 0)) { this.zone = null; this.highSince = null; return events }
    const zone = hrZoneOf(hr, this.maxHr)
    this.zone = zone

    if (zone === this.targetZone) {
      this.fill = Math.min(1, this.fill + dt / HRZ_FILL_SEC)
      if (this.fill >= 1 && this.boostRemaining <= 0) {
        this.fill = 0
        this.boosts++
        this.boostRemaining = HRZ_BOOST_SEC
        events.push({ kind: 'hr-boost', boosts: this.boosts })
      }
    } else if (zone < this.targetZone) {
      this.fill = Math.max(0, this.fill - dt / HRZ_DRAIN_SEC)
    }
    // 존보다 높으면 게이지는 그대로 — 과열로 채우는 건 아니다

    if (zone >= 5) {
      this.highSince ??= this.elapsed
      if (this.elapsed - this.highSince >= HRZ_HIGH_WARN_SEC && this.elapsed - this.lastWarnAt >= HRZ_HIGH_WARN_GAP) {
        this.lastWarnAt = this.elapsed
        events.push({ kind: 'hr-high', zone })
      }
    } else {
      this.highSince = null
    }
    return events
  }

  reset() {
    this.fill = 0
    this.boosts = 0
    this.boostRemaining = 0
    this.zone = null
    this.highSince = null
    this.lastWarnAt = -Infinity
    this.elapsed = 0
  }
}
