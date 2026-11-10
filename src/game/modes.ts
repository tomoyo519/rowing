/**
 * 플레이 모드 — 코스를 "타는" 것 위에 얹는 게임 요소.
 *
 * - 클래식: 페이스 보트를 옆에 두고 코스를 완주한다 (기존 동작).
 * - 상어 추격: 뒤에서 상어가 목표 페이스로 쫓아온다. 가끔 속도를 올려 덮치고, 잡히면 잠깐 물러났다 다시 온다.
 * - 추월 레이스: 앞서가는 라이벌을 따라잡아 추월한다. 추월할 때마다 더 빠른 라이벌이 더 멀리서 나타난다.
 *
 * 둘 다 **목표 페이스(페이스 보트 속도)를 기준**으로 움직여서, 코스의 구간 강도가 그대로 적용된다 —
 * 회복 구간에선 상어도 느려지고, 라이벌도 함께 쉰다. 상대보다 빠른지 느린지는 결국 목표 대비 내 페이스다.
 *
 * 순수 로직이라 three·DOM 없이 테스트한다. 3D 배치는 view.ts, 숫자·알림은 raceHud.ts·main.ts가 맡는다.
 */

export type GameModeId = 'classic' | 'shark' | 'chase'

export interface GameMode {
  id: GameModeId
  label: string
  /** 선택 화면 카드의 한 줄 */
  hint: string
  /** 선택했을 때 아래에 풀어 쓰는 설명 */
  description: string
  /** 카운트다운 뒤 첫 스트로크를 기다리는 동안 */
  waitHint: string
  /** 추적 상대를 부르는 이름 — 차이 칩·피드백 카드의 라벨 */
  actor: string
}

export const GAME_MODES: GameMode[] = [
  {
    id: 'classic', label: '클래식', hint: '페이스 보트와 함께',
    description: '회색 페이스 보트가 옆 레인에서 목표 페이스로 달립니다. 뒤처지지 않게 따라가세요.',
    waitHint: '페이스 보트가 옆에서 기다리는 중', actor: '페이스 보트',
  },
  {
    id: 'shark', label: '상어 추격', hint: '잡히지 마세요',
    description: '뒤에서 상어가 목표 페이스로 쫓아옵니다. 가끔 속도를 올려 덮치니, 경고가 뜨면 몇 스트로크 세게 당기세요. 잡히면 잠깐 물러났다 다시 옵니다.',
    waitHint: '상어가 뒤에서 기다리는 중', actor: '상어',
  },
  {
    id: 'chase', label: '추월 레이스', hint: '라이벌을 따라잡기',
    description: '앞서가는 라이벌을 따라잡아 추월하세요. 목표 페이스보다 빠르게 저어야 거리가 줄고, 추월할 때마다 더 빠른 라이벌이 더 멀리서 나타납니다.',
    waitHint: '라이벌이 앞에서 기다리는 중', actor: '라이벌',
  },
]

export function gameModeById(id: string | null | undefined): GameMode {
  return GAME_MODES.find(m => m.id === id) ?? GAME_MODES[0]!
}

/**
 * 이름 뒤에 붙는 조사를 받침에 맞게 고른다 — '노장이' / '번개가'.
 * 한글이 아니면(영문·숫자) 받침 있는 쪽을 쓴다.
 */
export function josa(word: string, withBatchim: string, without: string): string {
  const last = word.charCodeAt(word.length - 1)
  const hangul = last >= 0xac00 && last <= 0xd7a3
  const batchim = !hangul || (last - 0xac00) % 28 !== 0
  return `${word}${batchim ? withBatchim : without}`
}

/** 모드가 레이스 중 내보내는 사건. main.ts가 소리·알림으로 바꾼다. */
export type ModeEvent =
  /** 상어가 몇 초 뒤 속도를 올린다 */
  | { kind: 'shark-warn' }
  /** 상어가 지금 속도를 올렸다 */
  | { kind: 'shark-surge' }
  /** 상어에게 잡혔다 (n번째) */
  | { kind: 'shark-bite'; caught: number }
  /** 라이벌이 추월당하지 않으려고 버틴다 */
  | { kind: 'rival-contest'; name: string }
  /** 라이벌을 추월했다. next는 새로 나타난 라이벌 */
  | { kind: 'rival-overtake'; name: string; passed: number; next: string }

// ── 공용 ────────────────────────────────────────────────────

function hashString(value: string) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** 같은 seed면 같은 순서 — 테스트와 재현을 위해. */
function seededRandom(seed: string) {
  let state = hashString(seed) || 1
  return () => {
    state += 0x6d2b79f5
    let n = state
    n = Math.imul(n ^ (n >>> 15), n | 1)
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61)
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// ── 상어 ────────────────────────────────────────────────────

/** 출발할 때 상어 코끝이 내 선미에서 떨어져 있는 거리 (m) */
export const SHARK_HEAD_START = 30
/** 상어 코끝이 보트 중심에서 이만큼(m) 뒤에 오면 선미를 문 것이다 — 싱글스컬 반 길이 + 여유 */
export const SHARK_BITE_REACH = 4.5
/** 평소 상어 속도 = 목표 속도 × 1.0. 목표 페이스를 지키면 거리가 유지된다. */
export const SHARK_CRUISE_FACTOR = 1.0
/** 덮칠 때 속도 배율과 길이 (초) */
export const SHARK_SURGE_FACTOR = 1.12
export const SHARK_SURGE_SEC = 8
/** 덮치기 몇 초 전에 경고하는지 */
export const SHARK_WARN_SEC = 3
/** 덮치기 사이 간격 (초, seed로 이 범위에서 고른다). 첫 덮치기는 출발 뒤 최소 이만큼 뒤 */
export const SHARK_SURGE_GAP_MIN = 60
export const SHARK_SURGE_GAP_MAX = 110
export const SHARK_FIRST_SURGE_MIN = 45
/** 물고 나면 이만큼(초) 동안 이 배율로 느려져 뒤로 처진다 */
export const SHARK_RETREAT_SEC = 7
export const SHARK_RETREAT_FACTOR = 0.35
/** 속도가 목표에 붙는 관성 (초) */
export const SHARK_INERTIA_SEC = 1.2
/** 이 거리(m) 안으로 들어오면 위험도가 0에서 1로 오른다 — 출발 거리와 같아서 출발선에선 0이다 */
export const SHARK_DANGER_RANGE = SHARK_HEAD_START

export type SharkState = 'cruise' | 'warn' | 'surge' | 'retreat'

export interface SharkView {
  /** 내 선미에서 상어 코끝까지 (m). 0이면 물렸다 */
  gap: number
  /** 0(멀다) ~ 1(코앞) */
  danger: number
  state: SharkState
  /** 지금까지 물린 횟수 */
  caught: number
  /** 이번 세션에서 가장 멀리 떨어뜨린 거리 (m) */
  maxLead: number
  /** 상어의 현재 속도 (m/s) — 3D 꼬리질·항적용 */
  speed: number
}

export class SharkChase {
  /** 코끝의 코스 거리 (m) */
  distance = 0
  speed = 0
  state: SharkState = 'cruise'
  caught = 0
  maxLead = 0
  private nextSurgeAt = Infinity
  private surgeEndsAt = 0
  private retreatEndsAt = 0
  private readonly random: () => number

  constructor(seed = 'shark') {
    this.random = seededRandom(`${seed}:shark`)
  }

  /** 출발선. 상어는 내 뒤 SHARK_HEAD_START에서 함께 기다린다. */
  start(playerDistance = 0) {
    this.distance = playerDistance - SHARK_BITE_REACH - SHARK_HEAD_START
    this.speed = 0
    this.state = 'cruise'
    this.caught = 0
    this.maxLead = 0
    this.nextSurgeAt = SHARK_FIRST_SURGE_MIN + this.random() * (SHARK_SURGE_GAP_MAX - SHARK_FIRST_SURGE_MIN)
  }

  private scheduleNext(elapsed: number) {
    this.nextSurgeAt = elapsed + SHARK_SURGE_GAP_MIN + this.random() * (SHARK_SURGE_GAP_MAX - SHARK_SURGE_GAP_MIN)
  }

  /**
   * @param dt           흐른 시간 (초)
   * @param elapsed      세션 시계 (초)
   * @param targetSpeed  지금 코스가 요구하는 속도 (m/s) — 페이스 보트의 목표 속도
   * @param playerDistance 내 보트 중심의 코스 거리 (m)
   */
  update(dt: number, elapsed: number, targetSpeed: number, playerDistance: number): ModeEvent[] {
    const events: ModeEvent[] = []

    // 상태 전이
    if (this.state === 'cruise' && elapsed >= this.nextSurgeAt - SHARK_WARN_SEC) {
      this.state = 'warn'
      events.push({ kind: 'shark-warn' })
    }
    if (this.state === 'warn' && elapsed >= this.nextSurgeAt) {
      this.state = 'surge'
      this.surgeEndsAt = elapsed + SHARK_SURGE_SEC
      events.push({ kind: 'shark-surge' })
    }
    if (this.state === 'surge' && elapsed >= this.surgeEndsAt) {
      this.state = 'cruise'
      this.scheduleNext(elapsed)
    }
    if (this.state === 'retreat' && elapsed >= this.retreatEndsAt) {
      this.state = 'cruise'
      this.scheduleNext(elapsed)
    }

    const factor = this.state === 'surge' ? SHARK_SURGE_FACTOR
      : this.state === 'retreat' ? SHARK_RETREAT_FACTOR
        : SHARK_CRUISE_FACTOR
    const want = Math.max(0, targetSpeed) * factor
    this.speed += (want - this.speed) * (1 - Math.exp(-dt / SHARK_INERTIA_SEC))
    this.distance += this.speed * dt

    const bite = playerDistance - SHARK_BITE_REACH
    if (this.distance >= bite) {
      // 상어는 추격자다 — 보트를 앞지르지 않는다. 물러나는 중엔 선미에 매달려 있을 뿐이다.
      this.distance = bite
      if (this.state !== 'retreat') {
        this.caught++
        this.state = 'retreat'
        this.retreatEndsAt = elapsed + SHARK_RETREAT_SEC
        this.speed = 0
        events.push({ kind: 'shark-bite', caught: this.caught })
      }
    }
    this.maxLead = Math.max(this.maxLead, this.gapTo(playerDistance))
    return events
  }

  /** 내 선미에서 상어 코끝까지 (m) */
  gapTo(playerDistance: number) {
    return Math.max(0, playerDistance - SHARK_BITE_REACH - this.distance)
  }

  view(playerDistance: number): SharkView {
    const gap = this.gapTo(playerDistance)
    return {
      gap,
      danger: clamp(1 - gap / SHARK_DANGER_RANGE, 0, 1),
      state: this.state,
      caught: this.caught,
      maxLead: this.maxLead,
      speed: this.speed,
    }
  }
}

// ── 라이벌 ──────────────────────────────────────────────────

export const RIVAL_NAMES = [
  '강변의 노장', '템스의 번개', '보스반 유령', '새벽 스컬러', '헨리 챔피언',
  '운하의 질주자', '바람의 블레이드', '마지막 라이벌',
]
/** 첫 라이벌이 앞서 있는 거리 (m). 다음 라이벌마다 RIVAL_LEAD_STEP씩 멀어지고 RIVAL_LEAD_MAX에서 멈춘다 */
export const RIVAL_FIRST_LEAD = 50
export const RIVAL_LEAD_STEP = 12
export const RIVAL_LEAD_MAX = 100
/** 라이벌 속도 = 목표 속도 × 배율. 첫 라이벌은 목표보다 6% 느리고, 다음마다 1.5%씩 빨라져 1.04에서 멈춘다 */
export const RIVAL_FIRST_FACTOR = 0.94
export const RIVAL_FACTOR_STEP = 0.015
export const RIVAL_FACTOR_MAX = 1.04
/** 라이벌 속도의 느린 흔들림 — 사람처럼 조금 빨라졌다 느려진다 */
export const RIVAL_WOBBLE = 0.025
/** 이 거리(m) 안으로 따라붙으면 라이벌이 한 번 버틴다 */
export const RIVAL_CONTEST_WITHIN = 15
export const RIVAL_CONTEST_SEC = 10
export const RIVAL_CONTEST_BOOST = 0.05
/** 내 보트 중심이 라이벌 중심을 이만큼(m) 지나야 추월이다 — 뱃머리가 선미를 완전히 빠져나간 뒤 */
export const RIVAL_PASS_MARGIN = 8
/** 추월당한 라이벌은 이 거리(m) 뒤로 멀어지면 더 그리지 않는다 */
export const RIVAL_FADE_BEHIND = 120
export const RIVAL_INERTIA_SEC = 1.0

export interface RivalSpec {
  index: number
  name: string
  lead: number
  factor: number
  wobblePeriod: number
  wobblePhase: number
}

export interface RivalView {
  index: number
  name: string
  /** 내 중심 − 라이벌 중심 (m). 음수면 라이벌이 앞 */
  gap: number
  passed: number
  contesting: boolean
  /** 라이벌 속도 (m/s) */
  speed: number
  /** 방금 추월당해 뒤로 멀어지는 직전 라이벌. 없으면 null */
  previous: { gap: number; speed: number } | null
}

export function rivalSpec(index: number, random: () => number): RivalSpec {
  return {
    index,
    name: RIVAL_NAMES[Math.min(index, RIVAL_NAMES.length - 1)]!,
    lead: Math.min(RIVAL_LEAD_MAX, RIVAL_FIRST_LEAD + index * RIVAL_LEAD_STEP),
    factor: Math.min(RIVAL_FACTOR_MAX, RIVAL_FIRST_FACTOR + index * RIVAL_FACTOR_STEP),
    wobblePeriod: 50 + random() * 40,
    wobblePhase: random() * Math.PI * 2,
  }
}

export class RivalChase {
  spec: RivalSpec
  /** 라이벌 보트 중심의 코스 거리 (m) */
  distance = 0
  speed = 0
  passed = 0
  private contestEndsAt = -1
  private contested = false
  private previous: { distance: number; speed: number } | null = null
  private readonly random: () => number

  constructor(seed = 'rival') {
    this.random = seededRandom(`${seed}:rival`)
    this.spec = rivalSpec(0, this.random)
  }

  start(playerDistance = 0) {
    this.passed = 0
    this.previous = null
    this.spawn(0, playerDistance)
  }

  private spawn(index: number, playerDistance: number) {
    this.spec = rivalSpec(index, this.random)
    this.distance = playerDistance + this.spec.lead
    this.speed = 0
    this.contested = false
    this.contestEndsAt = -1
  }

  get contesting() { return this.contestEndsAt >= 0 }

  update(dt: number, elapsed: number, targetSpeed: number, playerDistance: number): ModeEvent[] {
    const events: ModeEvent[] = []
    const base = Math.max(0, targetSpeed)
    const gap = playerDistance - this.distance

    if (!this.contested && gap >= -RIVAL_CONTEST_WITHIN) {
      this.contested = true
      this.contestEndsAt = elapsed + RIVAL_CONTEST_SEC
      events.push({ kind: 'rival-contest', name: this.spec.name })
    }
    if (this.contestEndsAt >= 0 && elapsed >= this.contestEndsAt) this.contestEndsAt = -1

    const wobble = 1 + RIVAL_WOBBLE * Math.sin((elapsed / this.spec.wobblePeriod) * Math.PI * 2 + this.spec.wobblePhase)
    const factor = this.spec.factor * wobble + (this.contesting ? RIVAL_CONTEST_BOOST : 0)
    this.speed += (base * factor - this.speed) * (1 - Math.exp(-dt / RIVAL_INERTIA_SEC))
    this.distance += this.speed * dt

    if (this.previous) {
      this.previous.distance += this.previous.speed * dt
      if (playerDistance - this.previous.distance > RIVAL_FADE_BEHIND) this.previous = null
    }

    if (playerDistance - this.distance >= RIVAL_PASS_MARGIN) {
      this.passed++
      const name = this.spec.name
      // 추월당한 라이벌은 제 속도로 계속 저으며 뒤로 멀어진다 — 순간이동하면 눈에 띈다
      this.previous = { distance: this.distance, speed: this.speed }
      this.spawn(this.spec.index + 1, playerDistance)
      events.push({ kind: 'rival-overtake', name, passed: this.passed, next: this.spec.name })
    }
    return events
  }

  view(playerDistance: number): RivalView {
    return {
      index: this.spec.index,
      name: this.spec.name,
      gap: playerDistance - this.distance,
      passed: this.passed,
      contesting: this.contesting,
      speed: this.speed,
      previous: this.previous
        ? { gap: playerDistance - this.previous.distance, speed: this.previous.speed }
        : null,
    }
  }
}
