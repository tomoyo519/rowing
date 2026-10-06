/**
 * 그래픽 품질 티어.
 *
 * 반사·후처리·그림자 해상도는 iPad에서 프레임을 갉아먹을 수 있다. 시작은 high로 하고,
 * 프레임 시간이 계속 길면 한 단계씩 내린다 (다시 올리지는 않는다 — 오르내리면 화면이 깜빡인다).
 * `?quality=low|medium|high`로 고정할 수 있다.
 */
export type QualityTier = 'high' | 'medium' | 'low'

export interface QualitySettings {
  tier: QualityTier
  /** 화면 대비 반사 텍스처 배율. 0이면 반사 끔 */
  reflectionScale: number
  /** 블룸 등 후처리 */
  bloom: boolean
  /** 안티에일리어싱 후처리 (SMAA). 꺼지면 MSAA 대신 아무것도 안 한다 */
  smaa: boolean
  shadowMapSize: number
  pixelRatioCap: number
  /** 강변 풀포기 인스턴스 수 배율 */
  vegetation: number
}

export const QUALITY_PRESETS: Record<QualityTier, QualitySettings> = {
  high: { tier: 'high', reflectionScale: 0.5, bloom: true, smaa: true, shadowMapSize: 2048, pixelRatioCap: 1.5, vegetation: 1 },
  medium: { tier: 'medium', reflectionScale: 0.35, bloom: true, smaa: false, shadowMapSize: 1536, pixelRatioCap: 1.25, vegetation: 0.6 },
  low: { tier: 'low', reflectionScale: 0, bloom: false, smaa: false, shadowMapSize: 1024, pixelRatioCap: 1, vegetation: 0.3 },
}

const ORDER: QualityTier[] = ['high', 'medium', 'low']

/** URL로 고정한 티어가 있으면 그것, 없으면 high */
export function initialQuality(search = typeof location !== 'undefined' ? location.search : ''): { tier: QualityTier; locked: boolean } {
  const q = new URLSearchParams(search).get('quality')
  if (q === 'high' || q === 'medium' || q === 'low') return { tier: q, locked: true }
  return { tier: 'high', locked: false }
}

/**
 * 프레임 시간을 지켜보다 느리면 한 단계 내린다.
 * 셰이더 컴파일·탭 전환 직후의 긴 프레임은 무시하도록 이동 중앙값을 쓴다.
 */
export class QualityGovernor {
  tier: QualityTier
  private samples: number[] = []
  private settledAt = 0
  private clock = 0

  constructor(tier: QualityTier, private locked = false, private onChange?: (tier: QualityTier) => void) {
    this.tier = tier
  }

  get settings() { return QUALITY_PRESETS[this.tier] }

  /** @param dt 프레임 간격 (초) */
  update(dt: number) {
    if (this.locked || this.tier === 'low') return
    this.clock += dt
    // 시작·티어 변경 직후 4초는 셰이더가 컴파일되느라 느리다 — 재지 않는다
    if (this.clock - this.settledAt < 4) return
    if (dt < 0.25) this.samples.push(dt)
    if (this.samples.length < 120) return
    const sorted = [...this.samples].sort((a, b) => a - b)
    const median = sorted[sorted.length >> 1]!
    this.samples.length = 0
    // 중앙값이 30fps(33ms)에 못 미치면 내린다
    if (median > 0.034) this.step()
  }

  private step() {
    const next = ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(this.tier) + 1)]!
    if (next === this.tier) return
    this.tier = next
    this.settledAt = this.clock
    this.onChange?.(next)
  }
}
