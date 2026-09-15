import { describe, expect, it } from 'vitest'
import { StrokeEngine, catchError, easePeak } from './stroke'

/** 60fps로 sec초 동안 굴리며 매 프레임 위상을 기록한다. */
function run(engine: StrokeEngine, sec: number, onFrame?: (i: number) => void) {
  const phases: number[] = []
  const frames = Math.round(sec * 60)
  for (let i = 0; i < frames; i++) {
    onFrame?.(i)
    engine.update(1 / 60)
    phases.push(engine.phase)
  }
  return phases
}

/** 한 프레임에서 위상이 얼마나 뛰었는지 (wrap은 제외) */
function maxJump(phases: number[]) {
  let worst = 0
  for (let i = 1; i < phases.length; i++) {
    const d = phases[i]! - phases[i - 1]!
    if (d < -0.5) continue          // 1 → 0 wrap
    worst = Math.max(worst, Math.abs(d))
  }
  return worst
}

describe('catchError', () => {
  it('캐치를 살짝 지났으면 되감고, 거의 다 돌았으면 앞으로 민다', () => {
    expect(catchError(0.12)).toBeCloseTo(-0.12)
    expect(catchError(0.85)).toBeCloseTo(0.15)
    expect(catchError(0)).toBe(-0)
    expect(catchError(0.25)).toBeCloseTo(-0.25)
    expect(catchError(0.26)).toBeCloseTo(0.74)
  })
})

describe('StrokeEngine 위상 보정', () => {
  it('리커버리 중 늦은 strokeCount가 와도 위상이 순간이동하지 않는다', () => {
    const e = new StrokeEngine()
    e.onSample(26, 0, 0)
    run(e, 1)                       // spm 평활화
    e.phase = 0.85
    e.onSample(26, 1, 1000)         // 실제로는 캐치인데 화면은 아직 0.85
    const phases = run(e, 0.6)
    // 26spm은 프레임당 0.0072 전진. 3.5배 한도라 0.026을 넘지 않는다.
    expect(maxJump(phases)).toBeLessThan(0.03)
    // 0.6초 뒤엔 오차가 흡수되어 있어야 한다: 보정 없이 굴렸을 때(0.85 + 0.26 = 0.11)보다 앞서 있다
    expect(phases.at(-1)!).toBeGreaterThan(0.2)
  })

  it('캐치를 조금 지난 뒤 strokeCount가 와도 위상이 뒤로 가거나 멈추지 않는다', () => {
    const e = new StrokeEngine()
    e.onSample(26, 0, 0)
    run(e, 1)
    e.phase = 0.12
    e.onSample(26, 1, 1000)
    const phases = run(e, 0.5)
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i]!).toBeGreaterThan(phases[i - 1]!)   // 항상 전진
    }
    // 하지만 보정 없이 굴렸을 때보다는 뒤에 있어야 한다
    expect(phases.at(-1)!).toBeLessThan(0.12 + 0.5 * 26 / 60)
  })

  it('위상을 즉시 0으로 스냅하지 않는다', () => {
    const e = new StrokeEngine()
    e.onSample(26, 0, 0)
    run(e, 1)
    e.phase = 0.7
    e.onSample(26, 1, 1000)
    expect(e.phase).toBeCloseTo(0.7)
  })

  it('멈추면 되감지 않고 스트로크를 마저 끝낸 뒤 캐치에 선다', () => {
    const e = new StrokeEngine()
    e.onSample(26, 0, 0)
    run(e, 1)
    e.phase = 0.6
    e.onSample(0, undefined, 2000)
    // targetSpm은 0이 안 되게 막혀 있으니 직접 낮춘다
    ;(e as unknown as { targetSpm: number }).targetSpm = 0
    const phases = run(e, 4)
    // spm이 1 아래로 떨어진 뒤로는 계속 앞으로 가서 1(=0)에 도착한다
    const tail = phases.slice(-60)
    expect(tail.every(p => p < 0.01)).toBe(true)
    // 정지 구간에서 0.6 → 0.25 같은 역행이 없었는지
    let rewound = false
    for (let i = 1; i < phases.length; i++) {
      const d = phases[i]! - phases[i - 1]!
      if (d < -0.5) continue          // 1 → 0 wrap은 도착이지 되감기가 아니다
      if (d < -0.02) rewound = true
    }
    expect(rewound).toBe(false)
  })

  it('reset은 보정도 지운다', () => {
    const e = new StrokeEngine()
    e.onSample(26, 0, 0)
    run(e, 1)
    e.phase = 0.9
    e.onSample(26, 1, 1000)
    e.reset()
    const phases = run(e, 0.2)
    expect(phases.every(p => p === 0)).toBe(true)
  })
})

describe('레이트 0 처리와 coast', () => {
  it('레이트 0이 충분히 오래 이어지면 노를 놓은 것으로 보고 캐치에서 멈춘다', () => {
    const e = new StrokeEngine()
    e.onSample(26, 0, 0)
    run(e, 1)
    expect(e.spm).toBeGreaterThan(20)
    e.onSample(0, undefined, 500)
    e.onSample(0, undefined, 1500)
    e.onSample(0, undefined, 3100)      // 2.6초째
    run(e, 4)
    expect(e.spm).toBeLessThan(0.5)
    expect(e.phase).toBeLessThan(0.01)
  })

  it('레이트 0이 잠깐(리커버리)만 오면 계속 젓는다', () => {
    const e = new StrokeEngine()
    e.onSample(26, 0, 0)
    run(e, 1)
    e.onSample(0, undefined, 500)
    e.onSample(0, undefined, 2500)      // 2초 — 아직 멈춤 아님
    run(e, 1)
    expect(e.spm).toBeGreaterThan(20)
  })

  it('레이트가 0이어도 같은 샘플에서 스트로크나 거리가 늘었으면 젓는 중이다', () => {
    const e = new StrokeEngine()
    e.onSample(26, 0, 0)
    run(e, 1)
    for (let at = 500; at <= 6000; at += 500) e.onSample(0, undefined, at, true)
    run(e, 1)
    expect(e.spm).toBeGreaterThan(20)
  })

  it('움직임이 감지되면 이전 0-rate 타이머를 버린다', () => {
    const e = new StrokeEngine()
    e.onSample(26, 0, 0)
    run(e, 1)
    e.onSample(0, undefined, 500)
    e.onSample(0, undefined, 2500, true)
    e.onSample(0, undefined, 3100)
    run(e, 1)
    expect(e.spm).toBeGreaterThan(20)
  })

  it('처음부터 레이트 0이어도 스트로크 카운트가 늘면 간격으로 레이트를 추정한다', () => {
    const e = new StrokeEngine()
    e.onSample(0, 10, 100, false)
    e.onSample(0, 11, 2100, true)
    e.onSample(0, 12, 4100, true)
    run(e, 1)
    expect(e.spm).toBeGreaterThan(20)
    expect(e.spm).toBeLessThan(35)
  })

  it('60spm 넘는 레이트는 잘못 파싱된 패킷이라 무시한다', () => {
    const e = new StrokeEngine()
    e.onSample(26, 0, 0)
    run(e, 1)
    e.onSample(4000, undefined, 500)
    run(e, 1)
    expect(e.spm).toBeLessThan(30)
  })

  it('coast()는 즉시 멈추기 시작한다 — 페이스 보트가 출발 전에 기다릴 때', () => {
    const e = new StrokeEngine()
    e.onSample(26, 0, 0)
    run(e, 1)
    e.coast()
    run(e, 4)
    expect(e.spm).toBeLessThan(0.5)
    expect(e.phase).toBeLessThan(0.01)
  })
})

describe('사람다운 자세 타이밍', () => {
  function engineAt(spm: number) {
    const e = new StrokeEngine()
    e.onSample(spm, 0, 0); e.update(0.5); e.update(0.5); e.update(0.5)
    return e
  }

  it('easePeak은 0에서 1로 단조 증가하고 a=0.5면 easeInOut과 같다', () => {
    let prev = 0
    for (let i = 1; i <= 100; i++) {
      const v = easePeak(i / 100, 0.28)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
    expect(easePeak(1, 0.28)).toBe(1)
    expect(easePeak(0.25, 0.5)).toBeCloseTo(2 * 0.25 * 0.25)
    expect(easePeak(0.75, 0.5)).toBeCloseTo(1 - 2 * 0.25 * 0.25)
  })

  it.each([20, 26, 36])('%dspm에서 캐치·피니시를 지나도 슬라이드·몸통·팔의 속도가 뛰지 않는다', spm => {
    const e = engineAt(spm)
    const N = 1200
    const rows: number[][] = []
    for (let i = 0; i <= N; i++) {
      e.phase = i / N
      const p = e.pose()
      rows.push([p.slide, p.bodyAngle, p.armDraw])
    }
    // 위상 1과 0은 같은 자세다 — 그래야 순환이 이어진다
    for (let k = 0; k < 3; k++) expect(rows[N]![k]).toBeCloseTo(rows[0]![k]!, 6)
    for (let k = 0; k < 3; k++) {
      const v: number[] = []
      for (let i = 1; i <= N; i++) v.push(rows[i]![k]! - rows[i - 1]![k]!)
      let worst = 0
      for (let i = 0; i < v.length; i++) {
        const prev = v[(i - 1 + v.length) % v.length]!
        worst = Math.max(worst, Math.abs(v[i]! - prev))
      }
      // 예전 easeOut/easeIn은 캐치에서 0.0075, 피니시에서 0.0116(한 스텝당)씩 튀었다
      expect(worst).toBeLessThan(0.002)
    }
  })

  it('캐치 근처에서 상체가 얼어붙지 않는다 — 슬라이드 끝에 조금 더 뻗고 드라이브 초반에 풀린다', () => {
    const e = engineAt(26)
    const df = e.driveFraction
    e.phase = df + (1 - df) * 0.62
    const beforeReach = e.pose().bodyAngle
    e.phase = 0
    const atCatch = e.pose().bodyAngle
    e.phase = df * 0.3
    const hang = e.pose().bodyAngle
    expect(atCatch).toBeGreaterThan(beforeReach + 0.03)
    expect(hang).toBeLessThan(atCatch - 0.03)
  })

  it('스트로크마다 캐치 자세가 조금씩 다르지만 한계 안에 머문다', () => {
    const e = new StrokeEngine(7)
    e.onSample(26, 0, 0)
    const leans = new Set<string>()
    let prev = e.phase
    for (let i = 0; i < 60 * 30; i++) {          // 30초 ≈ 13 스트로크
      e.update(1 / 60)
      if (e.phase < prev) {
        const p = e.pose()
        leans.add(p.bodyAngle.toFixed(3))
        expect(p.slide).toBeLessThan(0.04)
        expect(Math.abs(p.bodyAngle - 0.47)).toBeLessThan(0.035)
      }
      prev = e.phase
    }
    expect(leans.size).toBeGreaterThan(3)
  })

  it('버릇이 여러 번 바뀐 뒤에도 실제 위상 wrap에서 자세가 이어진다', () => {
    const e = new StrokeEngine(17)
    e.onSample(30, 0, 0)
    let previous = e.pose()
    let wraps = 0

    // 직접 phase를 놓는 대신 실제 update로 여러 스트로크를 넘겨야 wobble 교체 경계를 검사할 수 있다.
    for (let i = 0; i < 240 * 30; i++) {
      e.update(1 / 240)
      const current = e.pose()
      if (current.phase < previous.phase) {
        wraps++
        expect(Math.abs(current.slide - previous.slide)).toBeLessThan(0.002)
        expect(Math.abs(current.bodyAngle - previous.bodyAngle)).toBeLessThan(0.002)
        expect(Math.abs(current.armDraw - previous.armDraw)).toBeLessThan(0.002)
      }
      previous = current
    }
    expect(wraps).toBeGreaterThan(5)
  })

  it('같은 seed는 같은 버릇을 내고, 다른 seed는 다르다', () => {
    const sample = (seed: number) => {
      const e = new StrokeEngine(seed)
      e.onSample(26, 0, 0)
      for (let i = 0; i < 60 * 5; i++) e.update(1 / 60)
      e.phase = 0
      return e.pose().bodyAngle
    }
    expect(sample(2)).toBe(sample(2))
    expect(sample(2)).not.toBe(sample(3))
  })

  it('reset은 버릇도 지운다', () => {
    const e = new StrokeEngine(5)
    e.onSample(26, 0, 0)
    for (let i = 0; i < 60 * 5; i++) e.update(1 / 60)
    e.reset()
    const fresh = new StrokeEngine(5)
    expect(e.pose().bodyAngle).toBe(fresh.pose().bodyAngle)
    expect(e.pose().slide).toBe(fresh.pose().slide)
  })
})
