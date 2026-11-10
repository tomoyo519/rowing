import type { ComboEvent } from './combo'
import type { ZoneEvent } from './powerZones'
import type { SwanEvent } from './wildlife'
import type { CheckpointPass } from './checkpoints'
import type { HrEvent } from './hrZone'
import { seededRandom } from './random'

/**
 * 콕스(cox) — 노 젓는 사람 옆에서 짧게 외치는 목소리.
 *
 * "하나, 둘"이 아니라 지금 할 동작 하나를 준다: 다리, 길이, 호흡. 상황(뒤처짐·앞섬·구간 예고·마지막 1분)은 1초에 한 번 보고
 * 40초에 한 번만 말한다. 사건(콤보·파워 구간·백조·체크포인트·심박)은 바로 말하되 4초 안에 겹치지 않는다.
 * 구간 전환 음성(cues.segment)과 5분 피드백 음성과 겹치지 않게 바깥에서 hush()를 준다.
 *
 * 순수 로직 — 문구만 돌려주고 소리는 coxVoice.ts가 낸다.
 */
export const COX_MIN_GAP = 4
export const COX_GENERIC_GAP = 40
/** 이만큼(초) 계속 뒤처지면 말한다 */
export const COX_BEHIND_AFTER = 20
/** 목표보다 이만큼(초) 이상 빠른 상태가 이어지면 아끼라고 한다 */
export const COX_AHEAD_DELTA = -6
export const COX_AHEAD_AFTER = 20
/** 목표 유지 칭찬 간격 (초) */
export const COX_PRAISE_GAP = 90
/** 다음 구간 예고 시점 (초 전) */
export const COX_PRESEGMENT_AT = 12

export interface CoxTick {
  elapsed: number
  remaining: number
  /** 지금 스플릿 − 목표 (초). 값이 없으면 Infinity */
  delta: number
  spm: number
  running: boolean
  /** 다음 구간까지 (초). 없으면 null */
  nextStepIn: number | null
  nextLabel: string | null
  nextHarder: boolean
}

export type CoxEvent =
  | ComboEvent
  | ZoneEvent
  | SwanEvent
  | HrEvent
  | { kind: 'checkpoint'; pass: CheckpointPass }
  | { kind: 'weather'; label: string | null; mult: number }
  | { kind: 'launch' }

const BEHIND_LEGS = ['다리! 캐치에서 다리부터 밀어요', '다리로 밀고, 팔은 마지막에', '발판을 차요. 다리가 엔진이에요']
const BEHIND_LENGTH = ['레이트 말고 길이. 한 번에 길게 밀어요', '서두르지 말고 한 번에 길게. 미끄러지게 두세요', '레이트를 둘 내리고 스트로크를 길게']
const AHEAD = ['빨라요. 조금 아껴요, 뒤에서 써야죠', '좋은데 너무 빨라요. 길게 미끄러지며 호흡', '여유 있어요. 리듬만 지켜요']
const PRAISE = ['리듬 좋아요. 그대로 가요', '딱 좋아요. 호흡만 지켜요', '메트로놈 같아요. 이대로', '좋아요, 보트가 잘 달려요']
const PRE_HARDER = ['곧 %s. 호흡 넣고 다리 준비', '%s 들어갑니다. 열 번 세게', '잠시 뒤 %s. 지금 숨 고르고']
const PRE_EASIER = ['곧 %s. 잘 버텼어요, 길게 풀어요', '%s 구간이에요. 어깨 내리고 호흡', '곧 %s. 리듬은 유지하고 힘만 빼요']
const COMBO_LINES: Record<number, string> = {
  10: '열 번 연속! 리듬 탔어요',
  25: '스물다섯 콤보! 메트로놈이에요',
  50: '쉰 콤보! 이게 실력이에요',
  100: '백 콤보! 전설이에요',
  200: '이백 콤보! 믿기지 않아요',
}

export class Cox {
  private lastSpeechAt = -Infinity
  private lastGenericAt = -Infinity
  private lastPraiseAt = 0
  private lastSecond = -1
  private behindSince: number | null = null
  private aheadSince: number | null = null
  private preSegmentFor: string | null = null
  private saidLastMinute = false
  private saidLast30 = false
  private hushUntil = -Infinity
  private readonly random: () => number
  /** 이번 세션에서 말한 줄 수 — 테스트·요약용 */
  spoken = 0

  constructor(seed = 'cox') {
    this.random = seededRandom(`${seed}:cox`)
  }

  /** 다른 음성(구간 전환·피드백)이 나가는 동안 입을 다문다 */
  hush(untilElapsed: number) {
    this.hushUntil = Math.max(this.hushUntil, untilElapsed)
  }

  private pick(pool: readonly string[]): string {
    return pool[Math.floor(this.random() * pool.length)]!
  }

  private canSpeak(elapsed: number) {
    return elapsed >= this.hushUntil && elapsed - this.lastSpeechAt >= COX_MIN_GAP
  }

  private speak(elapsed: number, line: string, generic: boolean): string {
    this.lastSpeechAt = elapsed
    if (generic) this.lastGenericAt = elapsed
    this.spoken++
    return line
  }

  /** 매 프레임 불러도 된다 — 초가 바뀔 때만 평가한다 */
  tick(t: CoxTick): string | null {
    const sec = Math.floor(t.elapsed)
    if (sec === this.lastSecond) return null
    this.lastSecond = sec
    if (!t.running) return null

    // 상태 추적은 말을 못 하는 동안에도 한다
    const behind = isFinite(t.delta) && t.delta > 2
    const ahead = isFinite(t.delta) && t.delta <= COX_AHEAD_DELTA
    this.behindSince = behind ? (this.behindSince ?? t.elapsed) : null
    this.aheadSince = ahead ? (this.aheadSince ?? t.elapsed) : null
    if (!behind && !ahead && isFinite(t.delta) && this.lastPraiseAt === 0) this.lastPraiseAt = t.elapsed

    if (!this.canSpeak(t.elapsed)) return null

    // 1) 마지막 1분·30초 — 다른 규칙보다 우선
    if (t.remaining <= 30 && t.remaining > 0 && !this.saidLast30) {
      this.saidLast30 = true
      this.saidLastMinute = true
      return this.speak(t.elapsed, '30초! 열 번만 더!', false)
    }
    if (t.remaining <= 60 && t.remaining > 30 && !this.saidLastMinute) {
      this.saidLastMinute = true
      return this.speak(t.elapsed, '마지막 1분! 남은 걸 다 쏟아요', false)
    }

    // 2) 구간 예고 — 구간마다 한 번
    if (t.nextStepIn !== null && t.nextLabel && t.nextStepIn <= COX_PRESEGMENT_AT && t.nextStepIn > COX_PRESEGMENT_AT - 4) {
      const key = `${t.nextLabel}@${Math.round(t.elapsed + t.nextStepIn)}`
      if (this.preSegmentFor !== key) {
        this.preSegmentFor = key
        const line = this.pick(t.nextHarder ? PRE_HARDER : PRE_EASIER).replace('%s', t.nextLabel)
        return this.speak(t.elapsed, line, false)
      }
    }

    if (t.elapsed - this.lastGenericAt < COX_GENERIC_GAP) return null

    // 3) 오래 뒤처짐
    if (this.behindSince !== null && t.elapsed - this.behindSince >= COX_BEHIND_AFTER) {
      this.behindSince = t.elapsed      // 다음 잔소리는 다시 20초 뒤
      return this.speak(t.elapsed, this.pick(t.spm >= 30 ? BEHIND_LENGTH : BEHIND_LEGS), true)
    }
    // 4) 너무 앞섬
    if (this.aheadSince !== null && t.elapsed - this.aheadSince >= COX_AHEAD_AFTER) {
      this.aheadSince = t.elapsed
      return this.speak(t.elapsed, this.pick(AHEAD), true)
    }
    // 5) 목표 유지 칭찬
    if (!behind && !ahead && isFinite(t.delta) && t.elapsed - this.lastPraiseAt >= COX_PRAISE_GAP) {
      this.lastPraiseAt = t.elapsed
      return this.speak(t.elapsed, this.pick(PRAISE), true)
    }
    return null
  }

  /** 사건 한 줄. 4초 안에 다른 말이 있었으면 건너뛴다 (콤보 10은 끊김보다 덜 중요하다는 식의 우선순위는 두지 않는다) */
  event(e: CoxEvent, elapsed: number): string | null {
    const line = lineFor(e)
    if (!line) return null
    if (!this.canSpeak(elapsed)) return null
    return this.speak(elapsed, line, false)
  }

  reset() {
    this.lastSpeechAt = -Infinity
    this.lastGenericAt = -Infinity
    this.lastPraiseAt = 0
    this.lastSecond = -1
    this.behindSince = null
    this.aheadSince = null
    this.preSegmentFor = null
    this.saidLastMinute = false
    this.saidLast30 = false
    this.hushUntil = -Infinity
    this.spoken = 0
  }
}

/** 사건 → 문구. 말할 게 없으면 null */
export function lineFor(e: CoxEvent): string | null {
  switch (e.kind) {
    case 'combo-milestone': return COMBO_LINES[e.count] ?? `${e.count} 콤보!`
    case 'combo-break': return '괜찮아요. 다시 쌓아요'
    case 'zone-soon': return '10초 뒤 파워 구간. 호흡 넣고'
    case 'zone-start': return '파워 구간! 30초 전력!'
    case 'zone-end': return e.success ? '성공! 다시 숨 고르고' : '아깝다. 다음 구간에서 다시'
    case 'swans-appear': return '백조 떼! 10초 안에 지나가요'
    case 'swans-result': return e.success ? '통과! 멋져요' : '백조가 먼저 갔어요. 괜찮아요'
    case 'hr-boost': return '심박 존 완성! 10초 부스트!'
    case 'hr-high': return '심박 높아요. 길게 내쉬어요'
    case 'checkpoint': {
      const g = Math.round(e.pass.gap)
      return `${e.pass.name} 통과. ${Math.abs(g)}미터 ${g >= 0 ? '앞' : '뒤'}`
    }
    case 'weather':
      if (!e.label) return null
      return e.label === '무지개' ? '무지개! 코인 3배!' : `${e.label}${e.label === '눈' ? '!' : '가 와요.'} 코인 ${trimMult(e.mult)}배`
    case 'launch': return null
  }
}

function trimMult(m: number) {
  return Number.isInteger(m) ? String(m) : m.toFixed(1)
}
