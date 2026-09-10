import { describe, expect, it } from 'vitest'
import { StrokeEngine, catchError } from './stroke'

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
