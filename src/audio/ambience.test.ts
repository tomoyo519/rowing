import { describe, expect, it } from 'vitest'
import { AmbientEventScheduler, type AmbientEventKind } from './ambience'

const near = {
  duck: { distance: 9, pan: -0.65 },
  spectator: { distance: 17, pan: 0.72 },
}
const far = {
  duck: { distance: 99, pan: 0 },
  spectator: { distance: 99, pan: 0 },
}

function timeline(seed: string) {
  const scheduler = new AmbientEventScheduler(seed)
  const events: { at: number; kind: AmbientEventKind; pan: number }[] = []
  for (let at = 0; at <= 260; at++) {
    const event = scheduler.update({
      elapsedSec: at,
      active: true,
      strokeCue: at % 2 === 0 ? 'pull' : null,
      presence: near,
    })
    if (event) events.push({ at, kind: event.kind, pan: event.pan })
  }
  return events
}

describe('주변음 스케줄러', () => {
  it('같은 세션 seed에서 같은 드문 소리 타임라인을 만든다', () => {
    const first = timeline('session-42')
    expect(timeline('session-42')).toEqual(first)
    expect(first.some(event => event.kind === 'splash')).toBe(true)
    expect(first.some(event => event.kind === 'duck')).toBe(true)
    expect(first.some(event => event.kind === 'cheer')).toBe(true)

    for (const kind of ['splash', 'duck', 'cheer'] as const) {
      const times = first.filter(event => event.kind === kind).map(event => event.at)
      const minimum = kind === 'splash' ? 9 : kind === 'duck' ? 45 : 60
      for (let i = 1; i < times.length; i++) {
        expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(minimum)
      }
    }
  })

  it('오리와 관중이 멀리 있으면 소리를 미루고 가까워진 뒤에만 재생한다', () => {
    const scheduler = new AmbientEventScheduler('proximity')
    for (let at = 0; at < 100; at++) {
      expect(scheduler.update({
        elapsedSec: at, active: true, strokeCue: null, presence: far,
      })).toBeNull()
    }
    const heard = new Set<AmbientEventKind>()
    for (let at = 100; at < 120; at++) {
      const event = scheduler.update({
        elapsedSec: at, active: true, strokeCue: null, presence: near,
      })
      if (event) heard.add(event.kind)
    }
    expect(heard).toEqual(new Set<AmbientEventKind>(['duck', 'cheer']))
  })

  it('물 첨벙 소리는 예정 시간이 지나도 당김 시작에서만 난다', () => {
    const scheduler = new AmbientEventScheduler('stroke-cue')
    for (let at = 0; at < 30; at++) {
      expect(scheduler.update({
        elapsedSec: at, active: true, strokeCue: 'return', presence: far,
      })).toBeNull()
    }
    expect(scheduler.update({
      elapsedSec: 30, active: true, strokeCue: 'pull', presence: far,
    })?.kind).toBe('splash')
  })
})
