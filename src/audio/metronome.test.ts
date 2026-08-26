import { describe, expect, it } from 'vitest'
import { StrokeCueDetector, type StrokeCue } from './metronome'

describe('로잉 동작별 똑·딱 검출', () => {
  const feed = (detector: StrokeCueDetector, phases: number[], active = true) =>
    phases.map(phase => detector.update(phase, 26, 0.36, active))
      .filter((cue): cue is StrokeCue => cue !== null)

  it('당기기 시작과 복귀 시작에 한 번씩 울린다', () => {
    const detector = new StrokeCueDetector()
    const cues = feed(detector, [0.2, 0.35, 0.37, 0.7, 0.96, 0.01, 0.2, 0.37])
    expect(cues).toEqual(['return', 'pull', 'return'])
  })

  it('예상 캐치 직후 늦은 FTMS 보정이 와도 똑 소리는 중복되지 않는다', () => {
    const detector = new StrokeCueDetector()
    const cues = feed(detector, [0.7, 0.96, 0.01, 0.18, 0, 0.2, 0.37])
    expect(cues).toEqual(['pull', 'return'])
  })

  it('실기기의 캐치 보정이 먼저 와도 당기기 소리를 낸다', () => {
    const detector = new StrokeCueDetector()
    expect(feed(detector, [0.7, 0.82, 0])).toEqual(['pull'])
  })

  it('정지·잘못된 레이트·비활성 상태에서는 울리지 않고 재동기화한다', () => {
    const detector = new StrokeCueDetector()
    expect(detector.update(0.9, 26, 0.36, true)).toBeNull()
    expect(detector.update(0.01, 0, 0.36, true)).toBeNull()
    expect(detector.update(0.02, 26, 0.36, true)).toBeNull()
    expect(detector.update(Number.NaN, 26, 0.36, true)).toBeNull()
    expect(detector.update(0.01, 26, 0.36, false)).toBeNull()
  })

  it('reset 뒤 놓친 소리를 몰아서 재생하지 않는다', () => {
    const detector = new StrokeCueDetector()
    detector.update(0.8, 30, 0.36, true)
    detector.reset()
    expect(detector.update(0.4, 30, 0.36, true)).toBeNull()
  })
})
