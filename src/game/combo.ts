import { GAUGE_TOLERANCE } from './paceGauge'

/**
 * 리듬 콤보 — 스트로크 하나하나에 반응하는 첫 번째 재미 장치.
 *
 * 스트로크를 완료할 때마다 그 순간의 페이스가 목표 허용 범위(게이지의 '유지' 띠, ±2초) 안이거나 더 빠르면
 * 콤보가 하나 쌓인다. 느린 스트로크 한 번은 봐준다 — 캐치 하나 미끄러진 걸로 50콤보가 날아가면 억울하다.
 * **두 번 연속** 느리면 끊긴다. 10·25·50·100·200에서 단계가 오른다 (소리·물보라·칩이 커진다).
 *
 * 순수 로직이라 DOM·오디오 없이 테스트한다. 스트로크 완료 시점은 main.ts가 StrokeEngine의 위상 되감김으로 잡는다.
 */
export const COMBO_MILESTONES: readonly number[] = [10, 25, 50, 100, 200]
/** 이만큼 연속으로 느리면 끊긴다 */
export const COMBO_MAX_MISSES = 2
/** 이 콤보 이상을 잃었을 때만 '끊김'을 알린다 — 3콤보 끊긴 걸 매번 말하면 잔소리다 */
export const COMBO_BREAK_ANNOUNCE = 10
/** 목표 대비 이 초 안쪽(또는 더 빠름)이면 '좋은 스트로크'. 게이지의 유지 띠와 같은 값 */
export const COMBO_TOLERANCE = GAUGE_TOLERANCE

export type ComboEvent =
  | { kind: 'combo-milestone'; count: number; level: number }
  | { kind: 'combo-break'; count: number }

/** 0: 10 미만, 1: 10+, 2: 25+, 3: 50+, 4: 100+, 5: 200+ */
export function comboLevel(count: number): number {
  let level = 0
  for (const m of COMBO_MILESTONES) if (count >= m) level++
  return level
}

export class RhythmCombo {
  /** 지금 이어지는 콤보 */
  count = 0
  /** 이번 세션 최장 */
  best = 0
  /** 좋은 스트로크 총수 — 요약용 */
  goodStrokes = 0
  /** 평가한 스트로크 총수 */
  strokes = 0
  private misses = 0

  get level() { return comboLevel(this.count) }

  /**
   * 스트로크 하나가 끝났다.
   * @param delta 지금 스플릿 − 목표 스플릿 (초). +면 느림. 값이 없으면(Infinity) 느린 것으로 본다
   */
  onStroke(delta: number): ComboEvent | null {
    this.strokes++
    const good = isFinite(delta) && delta <= COMBO_TOLERANCE
    if (good) {
      this.misses = 0
      this.count++
      this.goodStrokes++
      if (this.count > this.best) this.best = this.count
      if (COMBO_MILESTONES.includes(this.count)) {
        return { kind: 'combo-milestone', count: this.count, level: comboLevel(this.count) }
      }
      return null
    }
    this.misses++
    if (this.misses < COMBO_MAX_MISSES) return null
    return this.breakCombo()
  }

  /** 노를 놓았다(레이트 0이 이어짐) — 콤보는 이어지지 않는다 */
  onStop(): ComboEvent | null {
    if (this.count === 0) { this.misses = 0; return null }
    return this.breakCombo()
  }

  private breakCombo(): ComboEvent | null {
    const lost = this.count
    this.count = 0
    this.misses = 0
    return lost >= COMBO_BREAK_ANNOUNCE ? { kind: 'combo-break', count: lost } : null
  }

  reset() {
    this.count = 0
    this.best = 0
    this.goodStrokes = 0
    this.strokes = 0
    this.misses = 0
  }
}
