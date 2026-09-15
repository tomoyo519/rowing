/**
 * 스트로크 위상 추적 + 자세 계산.
 *
 * 핵심 문제: FTMS는 초당 1~2회만 데이터를 주는데, 아바타는 60fps로 움직여야 한다.
 * 해법 —
 *   1) strokeRate(spm)로 위상을 매 프레임 굴린다 (외삽)
 *   2) strokeCount가 증가하면 실제로 한 스트로크가 끝난 것이므로 위상을 catch(0)로 맞춘다 (보정)
 *
 * 보정을 즉시 적용하면(`phase = 0`) 외삽이 조금만 어긋나도 아바타가 뚝 끊긴다.
 * 예를 들어 리커버리 중(phase 0.85)에 패킷이 오면 노가 순간이동한다.
 * 그래서 오차를 correction에 담아 두고 몇 프레임에 걸쳐 흡수한다 — 위상이 잠깐
 * 빨라지거나 느려질 뿐 절대 역행하지 않아서 화면에는 끊김이 보이지 않는다.
 */

export interface Pose {
  /** 0=catch(시트 앞) ~ 1=finish(시트 뒤) */
  slide: number
  /** 상체 각도(rad). +면 앞으로 숙임, -면 뒤로 젖힘 */
  bodyAngle: number
  /** 0=팔 펴짐 ~ 1=가슴까지 당김 */
  armDraw: number
  /** 노 각도(rad). 캐치에서 크고 피니시에서 작아진다 */
  oarAngle: number
  /** 드라이브 구간(블레이드가 물속)이면 true */
  inWater: boolean
  /** 사이클 내 위상 0~1 */
  phase: number
  /** 드라이브 구간 내 진행도 0~1 (리커버리면 1) */
  driveProgress: number
  /** 리커버리 구간 내 진행도 0~1 (드라이브면 0) — 호흡·보트 피치 같은 보조 동작에 쓴다 */
  recoveryProgress: number
  /**
   * 블레이드가 물에 잠긴 정도 0~1.
   * 캐치에서 한 프레임에 꽂히지 않고 드라이브 초반 짧게 내려가고, 피니시 직후 짧게 빠져나온다.
   */
  bladeDepth: number
  /**
   * 블레이드가 세워진 정도 0~1. 1이면 물을 미는 자세(스퀘어), 0이면 리커버리의 페더링(납작).
   * 실제 스컬러는 캐치 직전에 세우고 피니시 직후에 눕힌다.
   */
  square: number
}

interface StrokeWobble {
  catchLean: number
  finishLean: number
  catchSlide: number
  timing: number
}

function zeroWobble(): StrokeWobble {
  return { catchLean: 0, finishLean: 0, catchSlide: 0, timing: 0 }
}

export class StrokeEngine {
  /** 사이클 내 위상 0~1. 0 = catch */
  phase = 0
  /** 현재 스트로크 레이트 (spm) — 표시/애니메이션용으로 평활화된 값 */
  spm = 0

  private lastStrokeCount: number | null = null
  private targetSpm = 0
  /** 마지막 스트로크 감지 시각 (performance.now 기준 ms) */
  private lastCatchAt = 0
  /** 아직 흡수하지 못한 위상 오차. update()에서 조금씩 덜어낸다. */
  private correction = 0

  /** 레이트 0 샘플이 이어지기 시작한 시각 (ms). null이면 지금 0이 아니다 */
  private zeroRateSince: number | null = null

  /**
   * 이번 스트로크만의 미세한 차이. 사람은 같은 스트로크를 두 번 젓지 않는다 —
   * 캐치에서 조금 덜 숙이거나, 앞까지 다 못 가거나, 몸통이 반 박자 늦게 따라온다.
   * 같은 seed면 같은 순서로 움직이며, 다음 값은 리커버리 후반부터 부드럽게 섞인다.
   */
  private wobble = zeroWobble()
  /** 리커버리 후반에 미리 섞어 넣을 다음 스트로크의 버릇 */
  private nextWobble = zeroWobble()
  private readonly initialRng: number
  private rng: number

  /** @param seed 보트마다 다른 값을 주면 셋이 같은 순간에 같은 버릇을 내지 않는다 */
  constructor(seed = 0) {
    this.initialRng = ((Math.floor(seed) * 2654435761) >>> 0) || 1
    this.rng = this.initialRng
    const firstWobble = this.drawWobble()
    this.wobble = firstWobble
    this.nextWobble = firstWobble
  }

  /**
   * BLE 샘플 도착 시 호출.
   * @param moving 같은 샘플에서 strokeCount나 거리가 늘었는지 — 레이트가 0이어도 아직 젓는 중이다
   */
  onSample(strokeRate: number | undefined, strokeCount: number | undefined, at: number, moving = false) {
    // 거리나 스트로크가 실제로 늘었으면 이전 리커버리에서 시작된 0-rate 타이머는 끝난 것이다.
    if (moving) this.zeroRateSince = null
    if (strokeRate !== undefined) {
      if (strokeRate > 0 && strokeRate <= MAX_SPM) {
        this.targetSpm = strokeRate
        this.zeroRateSince = null
      } else if (strokeRate === 0 && !moving) {
        // 기기가 레이트 0을 충분히 오래 보고하면 노를 놓은 것이다. 예전엔 무시해서 아바타가 영원히 저었다.
        // 스트로크 사이에 잠깐 0을 보내는 콘솔이 있어 시간으로 판단한다.
        this.zeroRateSince ??= at
        if (at - this.zeroRateSince >= ZERO_RATE_MS) this.targetSpm = 0
      }
      // 60spm 넘는 값은 잘못 파싱된 패킷이다 — 무시
    }

    if (strokeCount !== undefined) {
      if (this.lastStrokeCount !== null && strokeCount > this.lastStrokeCount) {
        // 실제 스트로크 완료 → 지금 위상이 catch(0)여야 한다.
        // 위상을 직접 건드리지 않고 오차만 기록해서 update()가 부드럽게 따라잡게 한다.
        // 여러 스트로크가 한 패킷에 몰려 들어와도 목표는 어차피 catch 하나다.
        this.correction = catchError(this.phase - STROKE_COUNT_PHASE)
        // 기기가 spm을 안 주는 경우, 스트로크 간격에서 직접 계산
        if ((strokeRate === undefined || (strokeRate === 0 && moving)) && this.lastCatchAt > 0) {
          const dtMin = (at - this.lastCatchAt) / 60000
          if (dtMin > 0.005 && dtMin < 0.2) this.targetSpm = 1 / dtMin
        }
        this.lastCatchAt = at
      }
      this.lastStrokeCount = strokeCount
    }
  }

  /** 매 프레임 호출. dt 단위는 초. */
  update(dt: number) {
    // spm은 표시가 튀지 않게 평활화
    this.spm += (this.targetSpm - this.spm) * (1 - Math.exp(-dt / 0.5))

    if (this.spm > 1) {
      const base = (this.spm / 60) * dt
      let advance = base

      // 쌓인 오차를 조금씩 덜어 위상에 얹는다.
      if (this.correction !== 0) {
        let applied = this.correction * (1 - Math.exp(-dt / CORRECTION_TAU))
        // 아무리 밀려도 기본 속도의 30%로는 계속 나아가고, 아무리 당겨도 3.5배는 넘지 않는다.
        // 멈추거나 되감기면 그게 바로 눈에 보이는 끊김이다.
        applied = Math.max(-base * 0.7, Math.min(base * 2.5, applied))
        this.correction -= applied
        advance = base + applied
        if (Math.abs(this.correction) < 1e-4) this.correction = 0
      }

      this.phase += advance
      if (this.phase >= 1) {
        const wraps = Math.floor(this.phase)
        this.phase -= wraps
        for (let i = 0; i < wraps; i++) this.advanceWobble()
      }
    } else {
      // 멈춤: 젓던 스트로크를 마저 끝내고 캐치에 선다.
      // 위상을 0으로 되감으면 노와 몸이 거꾸로 움직이는 게 그대로 보인다.
      const k = 1 - Math.exp(-dt / 0.8)
      if (this.phase > CATCH_EASE_BACK) {
        const remaining = 1 - this.phase
        // 지수 감속만 쓰면 0.99 근처에서 영영 멈춘다. 최소 속도를 두어 캐치에 실제로 도착하게 한다.
        this.phase += Math.max(remaining * k, Math.min(remaining, STOP_MIN_RATE * dt))
        if (this.phase >= 0.999) {
          this.phase = 0
          this.advanceWobble()
        }
      } else {
        this.phase += (0 - this.phase) * k
      }
      this.correction = 0
    }
  }

  /** 노를 놓는다 — 지금 스트로크를 마저 끝내고 캐치에 서서 기다린다. 페이스 보트·고스트가 출발 전에 쓴다. */
  coast() {
    this.targetSpm = 0
  }

  reset() {
    this.phase = 0
    this.spm = 0
    this.targetSpm = 0
    this.lastStrokeCount = null
    this.lastCatchAt = 0
    this.correction = 0
    this.zeroRateSince = null
    this.rng = this.initialRng
    const firstWobble = this.drawWobble()
    this.wobble = firstWobble
    this.nextWobble = firstWobble
  }

  /** 리커버리에서 이미 섞인 값을 현재 버릇으로 넘기고, 그다음 값을 준비한다. */
  private advanceWobble() {
    this.wobble = this.nextWobble
    this.nextWobble = this.drawWobble()
  }

  /** 다음 스트로크의 버릇을 뽑는다. 결정적 LCG — 같은 seed면 같은 순서다. */
  private drawWobble(): StrokeWobble {
    const next = () => {
      this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0
      return this.rng / 4294967296 * 2 - 1     // -1..1
    }
    return {
      catchLean: next() * WOBBLE_LEAN,
      finishLean: next() * WOBBLE_LEAN,
      catchSlide: (next() + 1) * 0.5 * WOBBLE_SLIDE,
      timing: next() * WOBBLE_TIMING,
    }
  }

  /**
   * 드라이브가 사이클에서 차지하는 비율.
   * 실제 로잉은 저레이트에서 1:2(드라이브 1/3), 레이스 페이스에서 1:1에 가까워진다.
   */
  get driveFraction(): number {
    return clamp(0.30 + (this.spm - 16) * 0.006, 0.30, 0.48)
  }

  /** 현재 위상에서 아바타 자세를 만든다. */
  pose(): Pose {
    const df = this.driveFraction
    const p = this.phase
    const inWater = p < df
    const t = inWater ? p / df : (p - df) / (1 - df)

    // 다음 버릇을 캐치에서 갑자기 바꾸면 시트와 몸통이 순간이동한다. 리커버리 후반부터
    // 속도 0으로 섞어 두면 위상이 1→0으로 넘어갈 때 양쪽 자세가 정확히 이어진다.
    const wobbleBlend = inWater ? 0 : easeInOut(seg(t, WOBBLE_BLEND_START, 1))
    const timing = lerp(this.wobble.timing, this.nextWobble.timing, wobbleBlend)
    const catchSlide = lerp(this.wobble.catchSlide, this.nextWobble.catchSlide, wobbleBlend)
    const catchLean = lerp(this.wobble.catchLean, this.nextWobble.catchLean, wobbleBlend)
    const finishLean = lerp(this.wobble.finishLean, this.nextWobble.finishLean, wobbleBlend)
    let slide: number, body: number, armDraw: number, reach: number

    // 각 마디는 멈춘 상태에서 출발해 속도 정점을 찍고 다시 멈춘다(easePeak). 예전엔 다리가 캐치에서
    // 즉시 최고 속도로 튀어나가고 팔이 최고 속도인 채 가슴에 부딪혀 멈췄다 — 그게 기계처럼 보이는 첫째 이유였다.
    // 창을 겹쳐 놓아 어느 순간에도 어딘가는 움직이고 있다.
    if (inWater) {
      // 드라이브 순서: 다리 → 몸통 → 팔. 다리는 첫 30%에서 정점(폭발적이되 연속), 몸통이 넘겨받고 팔이 마무리한다.
      slide = easePeak(seg(t, 0.00, 0.62), 0.28)
      body = easePeak(seg(t, 0.20 + timing, 0.94 + timing), 0.45)
      armDraw = easePeak(seg(t, 0.44 + timing, 1.00), 0.62)
      // 캐치의 리치는 다리가 밀기 시작하면 풀린다 — 상체가 손잡이에 매달린다(hang)
      reach = 1 - easePeak(seg(t, 0.00, 0.30), 0.5)
    } else {
      // 리커버리 순서: 팔 → 몸통 → 다리. 슬라이드는 앞으로 갈수록 느려져 캐치에 살며시 닿는다.
      armDraw = 1 - easePeak(seg(t, 0.00, 0.34), 0.45)
      body = 1 - easePeak(seg(t, 0.10 + timing, 0.64 + timing), 0.5)
      slide = 1 - easePeak(seg(t, 0.30, 1.00), 0.38)
      // 슬라이드 마지막에 상체가 조금 더 뻗는다 — 몸통이 캐치 각도에서 얼어붙지 않는다
      reach = easePeak(seg(t, 0.62, 1.00), 0.5)
    }
    // 이번 스트로크는 앞까지 다 못 갔을 수도 있다 (catchSlide만큼 남긴다)
    slide = catchSlide + (1 - catchSlide) * slide
    const bodyAngle = lerp(CATCH_LEAN + catchLean, FINISH_LEAN + finishLean, body) + REACH_LEAN * reach

    const driveProgress = inWater ? t : 1
    const recoveryProgress = inWater ? 0 : t
    // 노는 드라이브 동안 캐치각 → 피니시각으로 쓸리고, 리커버리에 되돌아온다
    const oarT = inWater ? easeInOut(t) : 1 - easeInOut(t)
    const oarAngle = lerp(OAR_CATCH, OAR_FINISH, oarT)

    // 블레이드: 드라이브 초반 BLADE_ENTRY 동안 내려가고, 리커버리 초반 BLADE_EXIT 동안 올라온다
    const bladeDepth = inWater
      ? easeOut(seg(t, 0, BLADE_ENTRY))
      : 1 - easeIn(seg(t, 0, BLADE_EXIT))
    // 스퀘어: 리커버리 끝(캐치 직전)에 세우기 시작해 물에 들어갈 땐 다 세워져 있고, 빠져나오며 눕힌다
    const square = inWater
      ? 1
      : t < BLADE_EXIT
        ? 1 - easeInOut(seg(t, 0, BLADE_EXIT))
        : easeInOut(seg(t, 1 - SQUARE_UP, 1))

    return {
      slide, bodyAngle, armDraw, oarAngle, inWater, phase: p,
      driveProgress, recoveryProgress, bladeDepth, square,
    }
  }
}

/**
 * 위상 오차를 흡수하는 시간 상수 (초).
 * 짧으면 보정이 튀어 보이고, 길면 노 젓는 타이밍이 실제보다 밀린다.
 * 0.16초면 가장 빠른 레이스 페이스(약 40spm, 사이클 1.5초)에서도 한 사이클 안에 흡수된다.
 */
const CORRECTION_TAU = 0.16
/**
 * 이 위상 아래에서 멈추면 캐치로 살짝 되돌아간다.
 * 그보다 뒤면 한 바퀴 마저 돌아 캐치에 서는 쪽이 자연스럽다.
 */
const CATCH_EASE_BACK = 0.25
/** 멈출 때 캐치까지 마저 가는 최소 속도 (위상/초) */
const STOP_MIN_RATE = 0.25
/**
 * 기기가 strokeCount를 올리는 순간의 사이클 위상. 0 = 캐치.
 * 콘솔에 따라 드라이브가 끝나는 피니시(driveFraction ≈ 0.3~0.48)에서 세는 것도 있다.
 * 아바타가 사용자와 반 박자 어긋나 보이면 이 값을 driveFraction 근처로 옮겨 보라.
 */
const STROKE_COUNT_PHASE = 0
/** 레이트 0이 이만큼(ms) 이어지면 멈춘 것으로 본다 — 리커버리(최대 2.5초) 동안 0을 보내는 콘솔 대비 */
const ZERO_RATE_MS = 2500
/** 이보다 높은 레이트는 사람이 아니다 — 잘못 파싱된 패킷 */
const MAX_SPM = 60

/**
 * 지금 위상에서 캐치(0)까지 가는 데 필요한 위상 변화량.
 *
 * 사이클을 거의 다 돈 상태면 앞으로 조금 더 밀고(+), 캐치를 살짝 지났으면 되감는다(-).
 * 0.25를 경계로 잡아 리커버리 중에 온 패킷이 스트로크를 되감지 않게 한다.
 */
export function catchError(phase: number): number {
  const p = ((phase % 1) + 1) % 1
  return p <= CATCH_EASE_BACK ? -p : 1 - p
}

/** 드라이브 중 블레이드가 물에 잠기는 데 쓰는 비율 — 짧지만 한 프레임은 아니다 */
const BLADE_ENTRY = 0.10
/** 리커버리 중 블레이드가 빠져나오는 비율 */
const BLADE_EXIT = 0.10
/** 리커버리 마지막 이 비율 동안 블레이드를 다시 세운다 */
const SQUARE_UP = 0.22

/** 캐치에서 상체를 앞으로 숙인 각도 (rad) */
const CATCH_LEAN = 0.42
/** 캐치 직전·직후에 상체가 추가로 뻗는 각도 (rad) — 슬라이드 끝의 리치와 드라이브 초반의 hang */
const REACH_LEAN = 0.05
/** 스트로크마다 달라지는 숙임·젖힘 (rad), 못 미친 슬라이드(0~1 비율), 몸통·팔 타이밍(드라이브 비율) */
const WOBBLE_LEAN = 0.03
const WOBBLE_SLIDE = 0.03
const WOBBLE_TIMING = 0.03
/** 다음 스트로크의 미세한 차이를 섞기 시작하는 리커버리 진행도 */
const WOBBLE_BLEND_START = 0.55
/** 피니시에서 뒤로 젖힌 각도 (rad) */
const FINISH_LEAN = -0.32
/** 캐치에서의 노 각도 (rad) */
const OAR_CATCH = 0.95
/** 피니시에서의 노 각도 (rad) */
const OAR_FINISH = -0.55

/** t를 [a,b] 구간에 대해 0~1로 정규화 */
function seg(t: number, a: number, b: number): number {
  return clamp((t - a) / (b - a), 0, 1)
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
function easeIn(t: number): number { return t * t }
function easeOut(t: number): number { return 1 - (1 - t) * (1 - t) }
/**
 * 속도가 0에서 출발해 u=a에서 정점을 찍고 다시 0으로 떨어지는 이동 (삼각형 속도 프로파일의 적분).
 * a=0.5면 easeInOut과 같고, a가 작을수록 빨리 튀어나가 길게 감속한다 — 사람의 팔다리는 대개 이렇게 움직인다.
 */
export function easePeak(u: number, a: number): number {
  if (u <= 0) return 0
  if (u >= 1) return 1
  return u < a ? (u * u) / a : 1 - ((1 - u) * (1 - u)) / (1 - a)
}
function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}
