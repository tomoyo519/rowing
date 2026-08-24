/**
 * 스트로크 위상 추적 + 자세 계산.
 *
 * 핵심 문제: FTMS는 초당 1~2회만 데이터를 주는데, 아바타는 60fps로 움직여야 한다.
 * 해법 —
 *   1) strokeRate(spm)로 위상을 매 프레임 굴린다 (외삽)
 *   2) strokeCount가 증가하면 실제로 한 스트로크가 끝난 것이므로 위상을 catch(0)로 리셋한다 (보정)
 * 이렇게 하면 화면은 부드럽고, 실제 노 젓는 타이밍과도 어긋나지 않는다.
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

  /** BLE 샘플 도착 시 호출 */
  onSample(strokeRate: number | undefined, strokeCount: number | undefined, at: number) {
    if (strokeRate !== undefined && strokeRate > 0) this.targetSpm = strokeRate

    if (strokeCount !== undefined) {
      if (this.lastStrokeCount !== null && strokeCount > this.lastStrokeCount) {
        // 실제 스트로크 완료 → catch로 리셋.
        // 여러 스트로크가 한 패킷에 몰려 들어와도 위상은 어차피 0으로 맞추면 된다.
        this.phase = 0
        // 기기가 spm을 안 주는 경우, 스트로크 간격에서 직접 계산
        if (strokeRate === undefined && this.lastCatchAt > 0) {
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
      this.phase += (this.spm / 60) * dt
      // 다음 패킷에서 어차피 보정되므로 여기선 그냥 wrap
      if (this.phase >= 1) this.phase -= Math.floor(this.phase)
    } else {
      // 멈춤: catch 자세로 서서히 복귀
      this.phase += (0 - this.phase) * (1 - Math.exp(-dt / 0.8))
    }
  }

  reset() {
    this.phase = 0
    this.spm = 0
    this.targetSpm = 0
    this.lastStrokeCount = null
    this.lastCatchAt = 0
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

    let slide: number, bodyAngle: number, armDraw: number

    if (inWater) {
      // 드라이브 순서: 다리 → 몸통 → 팔 (실제 로잉 시퀀스)
      slide = easeOut(seg(t, 0.00, 0.55))
      const body = easeInOut(seg(t, 0.30, 1.00))
      armDraw = easeIn(seg(t, 0.60, 1.00))
      bodyAngle = lerp(CATCH_LEAN, FINISH_LEAN, body)
    } else {
      // 리커버리 순서: 팔 → 몸통 → 다리 (드라이브의 역순)
      armDraw = 1 - easeInOut(seg(t, 0.00, 0.30))
      const body = 1 - easeInOut(seg(t, 0.15, 0.65))
      slide = 1 - easeInOut(seg(t, 0.35, 1.00))
      bodyAngle = lerp(CATCH_LEAN, FINISH_LEAN, body)
    }

    const driveProgress = inWater ? t : 1
    // 노는 드라이브 동안 캐치각 → 피니시각으로 쓸리고, 리커버리에 되돌아온다
    const oarT = inWater ? easeInOut(t) : 1 - easeInOut(t)
    const oarAngle = lerp(OAR_CATCH, OAR_FINISH, oarT)

    return { slide, bodyAngle, armDraw, oarAngle, inWater, phase: p, driveProgress }
  }
}

/** 캐치에서 상체를 앞으로 숙인 각도 (rad) */
const CATCH_LEAN = 0.42
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
function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}
