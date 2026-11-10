import { range, seededRandom } from './random'

/**
 * 백조 떼 건너기 — 가벼운 미니 사건.
 *
 * 몇 분에 한 번, 앞쪽 강을 백조 떼가 가로지른다. 지금 속도로 약 11초 걸릴 지점에 10초 안에 닿으면 "통과",
 * 늦으면 백조가 먼저 간다. 10% 정도만 더 밀면 되는 짧은 스퍼트다. 실패해도 벌은 없다 — 코인을 못 받을 뿐이다.
 * 파워 구간과 겹치지 않게 바깥(컨트롤러)에서 blocked를 주면 15초 뒤로 미룬다.
 */
export const SWAN_FIRST_MIN = 120
export const SWAN_FIRST_MAX = 200
export const SWAN_GAP_MIN = 170
export const SWAN_GAP_MAX = 290
/** 통과 제한 시간 (초) */
export const SWAN_WINDOW_SEC = 10
/** 건너는 지점 = 지금 속도 × 이 초수 — 제한 시간보다 조금 길어 속도를 올려야 한다 */
export const SWAN_LEAD_SEC = 11
/** 아무리 느려도 이 거리(m)는 앞이다 */
export const SWAN_MIN_LEAD = 25
/** 코스 끝 이만큼(초) 안에는 안 나온다 */
export const SWAN_TAIL_SEC = 60
/** 막혔을 때(파워 구간·정지) 미루는 시간 (초) */
export const SWAN_POSTPONE_SEC = 15
/** 이 속도(m/s) 미만이면 젓는 중이 아니다 — 미룬다 */
const SWAN_MIN_SPEED = 1.0

export type SwanEvent =
  | { kind: 'swans-appear'; at: number; deadline: number }
  | { kind: 'swans-result'; success: boolean; margin: number }

export interface SwanView {
  /** 건너는 지점까지 (m). 음수면 지났다 */
  along: number
  /** 제한 시간까지 남은 초 */
  remaining: number
  /** 0..1 시간 진행 */
  progress: number
}

export class SwanCrossing {
  attempts = 0
  successes = 0
  private nextAt: number
  private at = 0
  private deadline = 0
  private active = false

  constructor(seed: string, private readonly durationSec: number) {
    const random = seededRandom(`${seed}:swans`)
    this.random = random
    this.nextAt = range(random, SWAN_FIRST_MIN, SWAN_FIRST_MAX)
  }
  private readonly random: () => number

  get isActive() { return this.active }

  update(elapsed: number, distance: number, speed: number, blocked = false): SwanEvent[] {
    const events: SwanEvent[] = []
    if (this.active) {
      if (distance >= this.at) {
        this.active = false
        this.successes++
        events.push({ kind: 'swans-result', success: true, margin: this.deadline - elapsed })
        this.schedule(elapsed)
      } else if (elapsed >= this.deadline) {
        this.active = false
        events.push({ kind: 'swans-result', success: false, margin: this.deadline - elapsed })
        this.schedule(elapsed)
      }
      return events
    }
    if (elapsed < this.nextAt) return events
    if (elapsed > this.durationSec - SWAN_TAIL_SEC) return events
    if (blocked || speed < SWAN_MIN_SPEED) {
      this.nextAt = elapsed + SWAN_POSTPONE_SEC
      return events
    }
    this.active = true
    this.attempts++
    this.at = distance + Math.max(SWAN_MIN_LEAD, speed * SWAN_LEAD_SEC)
    this.deadline = elapsed + SWAN_WINDOW_SEC
    events.push({ kind: 'swans-appear', at: this.at, deadline: this.deadline })
    return events
  }

  private schedule(elapsed: number) {
    this.nextAt = elapsed + range(this.random, SWAN_GAP_MIN, SWAN_GAP_MAX)
  }

  view(elapsed: number, distance: number): SwanView | null {
    if (!this.active) return null
    return {
      along: this.at - distance,
      remaining: Math.max(0, this.deadline - elapsed),
      progress: Math.min(1, Math.max(0, 1 - (this.deadline - elapsed) / SWAN_WINDOW_SEC)),
    }
  }
}
