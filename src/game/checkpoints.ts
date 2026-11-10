import type { Landmark } from './courses'

/**
 * 랜드마크 체크포인트.
 *
 * 코스의 랜드마크(헨리 브리지, 풍차…)를 지나는 순간 페이스 보트·내 최고 기록과의 차이를 찍어 준다.
 * 지루한 중반에 "다음 다리까지"라는 작은 목표가 생기고, 요약에서 어디서 벌리고 어디서 잃었는지 보인다.
 * 랜드마크 위치는 world.ts와 같은 규칙(at × 예상 완주 거리)이다.
 */
export interface Checkpoint {
  index: number
  name: string
  kind: Landmark['kind']
  /** 코스 거리 (m) */
  at: number
}

export interface CheckpointPass extends Checkpoint {
  /** 지날 때 세션 시계 (초) */
  elapsed: number
  /** 페이스 보트 대비 (m). +면 앞 */
  gap: number
  /** 고스트 대비 (m). 고스트가 없으면 null */
  ghostGap: number | null
  /** 직전 체크포인트(또는 출발)부터의 평균 스플릿 (초/500m) */
  legSplit: number
}

/** 출발 직후·결승 직전의 랜드마크는 뺀다 — 출발선 표지와 결승 표지가 체크포인트면 두 번 알린다 */
const MIN_AT = 0.03
const MAX_AT = 0.985

export function createCheckpoints(landmarks: readonly Landmark[], total: number): Checkpoint[] {
  return landmarks
    .filter(l => l.at >= MIN_AT && l.at <= MAX_AT)
    .sort((a, b) => a.at - b.at)
    .map((l, index) => ({ index, name: l.name, kind: l.kind, at: l.at * total }))
}

export class CheckpointTracker {
  readonly passes: CheckpointPass[] = []
  private next = 0
  private legStartElapsed = 0
  private legStartDistance = 0

  constructor(readonly points: readonly Checkpoint[]) {}

  /** 다음 체크포인트. 다 지났으면 null */
  get upcoming(): Checkpoint | null { return this.points[this.next] ?? null }

  update(distance: number, elapsed: number, gap: number, ghostGap: number | null): CheckpointPass[] {
    const out: CheckpointPass[] = []
    while (this.next < this.points.length && distance >= this.points[this.next]!.at) {
      const cp = this.points[this.next]!
      const legSeconds = elapsed - this.legStartElapsed
      const legMeters = distance - this.legStartDistance
      const pass: CheckpointPass = {
        ...cp, elapsed, gap, ghostGap,
        legSplit: legMeters > 0 && legSeconds > 0 ? (legSeconds / legMeters) * 500 : Infinity,
      }
      out.push(pass)
      this.passes.push(pass)
      this.legStartElapsed = elapsed
      this.legStartDistance = distance
      this.next++
    }
    return out
  }

  /** 페이스 보트보다 앞선 채 지난 체크포인트 수 */
  get leads(): number { return this.passes.filter(p => p.gap >= 0).length }
}
