import { describe, expect, it } from 'vitest'
import { CatchBeatDetector } from './metronome'

describe('로잉 메트로놈 catch 검출', () => {
  it('정상적인 phase wrap마다 정확히 한 번 울린다', () => {
    const detector = new CatchBeatDetector()
    const phases = [0.2, 0.45, 0.72, 0.96, 0.01, 0.01, 0.2, 0.9, 0.02]
    expect(phases.filter(phase => detector.update(phase, 26, true)).length).toBe(2)
  })

  it('FTMS strokeCount가 위상을 catch로 보정해도 한 번만 울린다', () => {
    const detector = new CatchBeatDetector()
    expect(detector.update(0.31, 24, true)).toBe(false)
    expect(detector.update(0, 24, true)).toBe(true)
    expect(detector.update(0, 24, true)).toBe(false)
  })

  it('정지·잘못된 레이트·비활성 상태에서는 울리지 않고 재동기화한다', () => {
    const detector = new CatchBeatDetector()
    expect(detector.update(0.9, 26, true)).toBe(false)
    expect(detector.update(0.01, 0, true)).toBe(false)
    expect(detector.update(0.02, 26, true)).toBe(true)
    expect(detector.update(Number.NaN, 26, true)).toBe(false)
    expect(detector.update(0.01, 26, false)).toBe(false)
  })

  it('reset 뒤 놓친 beat를 몰아서 재생하지 않는다', () => {
    const detector = new CatchBeatDetector()
    detector.update(0.8, 30, true)
    detector.reset()
    expect(detector.update(0.4, 30, true)).toBe(false)
  })
})
