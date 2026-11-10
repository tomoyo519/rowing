import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  kstDateKey, dateLabel, dailyChallenge, modeLabel, sanitizeNickname, loadNickname, saveNickname, deviceId,
  submitDaily, fetchLeaderboard, NICKNAME_KEY, DEVICE_KEY, NICKNAME_MAX, type DailySubmission,
} from './daily'
import { COURSES, PACE_TIERS } from './courses'
import { GAME_MODES } from './modes'

// node 환경엔 localStorage가 없다 — 최소 구현으로 대체
beforeEach(() => {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage
})

const realFetch = globalThis.fetch
afterEach(() => { (globalThis as { fetch: typeof fetch }).fetch = realFetch })

type Call = { url: string; init: RequestInit | undefined }
/** 전역 fetch를 바꿔치기하고 호출 기록을 돌려준다 */
function stubFetch(respond: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  ;(globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const call: Call = { url, init }
    calls.push(call)
    return respond(call)
  }) as typeof fetch
  return calls
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const dayOfNov = (d: number) => `2026-11-${String(d).padStart(2, '0')}`

describe('날짜', () => {
  it('kstDateKey는 UTC+9 기준 — 15:00Z부터 다음 날', () => {
    expect(kstDateKey(Date.UTC(2026, 10, 10, 16))).toBe('2026-11-11')
    expect(kstDateKey(Date.UTC(2026, 10, 10, 14, 59, 59))).toBe('2026-11-10')
    expect(kstDateKey(Date.UTC(2026, 10, 10, 15))).toBe('2026-11-11')
    expect(kstDateKey(Date.UTC(2026, 11, 31, 15))).toBe('2027-01-01')
  })

  it('kstDateKey() 기본값은 지금', () => {
    expect(kstDateKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('dateLabel은 "11월 10일"처럼 앞 0을 뗀다', () => {
    expect(dateLabel('2026-11-10')).toBe('11월 10일')
    expect(dateLabel('2026-01-05')).toBe('1월 5일')
  })
})

describe('오늘의 도전', () => {
  it('같은 날짜면 같은 도전 — 코스·모드·페이스·seed·라벨', () => {
    const a = dailyChallenge('2026-11-10')
    expect(a).toEqual(dailyChallenge('2026-11-10'))
    expect(a.date).toBe('2026-11-10')
    expect(a.seed).toBe('daily-2026-11-10')
    expect(a.label).toBe('11월 10일')
  })

  it('기본 날짜는 오늘(KST)', () => {
    expect(dailyChallenge().date).toBe(kstDateKey())
  })

  it('코스·모드는 실제 목록에서 고르고 페이스는 스테디·강하게·레이스 중 하나다', () => {
    const courseIds = new Set(COURSES.map(c => c.id))
    const modeIds = new Set<string>(GAME_MODES.map(m => m.id))
    const tierIds = new Set(PACE_TIERS.map(t => t.id))
    for (let d = 1; d <= 30; d++) {
      const c = dailyChallenge(dayOfNov(d))
      expect(courseIds.has(c.courseId)).toBe(true)
      expect(modeIds.has(c.mode)).toBe(true)
      expect(tierIds.has(c.tierId)).toBe(true)
      expect(['steady', 'strong', 'race']).toContain(c.tierId)
    }
  })

  it('날짜가 다르면 조건도 달라진다 — 한 달 안에 코스·모드·페이스가 두루 나온다', () => {
    const combos = new Set<string>()
    const modes = new Set<string>()
    const tiers = new Set<string>()
    const courses = new Set<string>()
    for (let d = 1; d <= 30; d++) {
      const c = dailyChallenge(dayOfNov(d))
      combos.add(`${c.courseId}|${c.mode}|${c.tierId}`)
      modes.add(c.mode)
      tiers.add(c.tierId)
      courses.add(c.courseId)
    }
    expect(combos.size).toBeGreaterThan(15)
    expect(modes.size).toBe(3)
    expect(tiers.size).toBe(3)
    expect(courses.size).toBeGreaterThan(5)
  })

  it('modeLabel은 모드 목록의 라벨을 쓴다', () => {
    for (const m of GAME_MODES) expect(modeLabel(m.id)).toBe(m.label)
  })
})

describe('별명', () => {
  it('제어문자와 <>를 지우고 앞뒤 공백을 떼며 12자로 자른다', () => {
    expect(NICKNAME_MAX).toBe(12)
    expect(sanitizeNickname('\u0000ab\u001fc\u007f')).toBe('abc')
    expect(sanitizeNickname('<b>x</b>')).toBe('bx/b')
    expect(sanitizeNickname('  노 젓는 사람  ')).toBe('노 젓는 사람')
    expect(sanitizeNickname('abcdefghijklmnop')).toBe('abcdefghijkl')
    expect(sanitizeNickname('abcdefghijklmnop')).toHaveLength(NICKNAME_MAX)
    // 공백을 뗀 뒤에 자른다
    expect(sanitizeNickname('    abcdefghijklmnop')).toBe('abcdefghijkl')
    expect(sanitizeNickname('')).toBe('')
    expect(sanitizeNickname('\n\t')).toBe('')
  })

  it('저장할 때도 읽을 때도 정리한다', () => {
    saveNickname('  <Rower>1  ')
    expect(localStorage.getItem(NICKNAME_KEY)).toBe('Rower1')
    expect(loadNickname()).toBe('Rower1')
  })

  it('저장된 게 없으면 빈 문자열', () => {
    expect(loadNickname()).toBe('')
  })

  it('localStorage가 없어도 던지지 않는다', () => {
    delete (globalThis as { localStorage?: Storage }).localStorage
    expect(() => saveNickname('x')).not.toThrow()
    expect(loadNickname()).toBe('')
  })
})

describe('deviceId', () => {
  it('16자리 16진수를 만들어 저장하고 다음부터는 같은 값을 준다', () => {
    const id = deviceId()
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(localStorage.getItem(DEVICE_KEY)).toBe(id)
    expect(deviceId()).toBe(id)
  })

  it('저장된 값이 형식에 안 맞으면 새로 만든다', () => {
    localStorage.setItem(DEVICE_KEY, 'not-a-device-id')
    const id = deviceId()
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(localStorage.getItem(DEVICE_KEY)).toBe(id)
  })

  it('localStorage가 없으면 anonymous-device', () => {
    delete (globalThis as { localStorage?: Storage }).localStorage
    expect(deviceId()).toBe('anonymous-device')
  })
})

const submission: DailySubmission = {
  date: '2026-11-10', name: 'Rower', distance: 6200, courseId: 'henley-steady-30', mode: 'classic', modeScore: 0, avgSplit: 140,
}

describe('submitDaily', () => {
  it('기록·기기 id·빌드를 JSON으로 POST하고 순위를 받는다', async () => {
    const calls = stubFetch(() => json({ rank: 3 }))
    const r = await submitDaily(submission, 'build-1')
    expect(r).toEqual({ ok: true, rank: 3 })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe('/api/daily')
    expect(call.init?.method).toBe('POST')
    const headers = call.init?.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-makerowing']).toBe('1')
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>
    expect(body).toEqual({ ...submission, build: 'build-1', deviceId: deviceId() })
  })

  it('서버가 거절하면 ok:false와 error 메시지', async () => {
    stubFetch(() => json({ error: 'too fast' }, 400))
    expect(await submitDaily(submission, 'b')).toEqual({ ok: false, error: 'too fast' })
  })

  it('본문이 JSON이 아니면 상태 코드를 error로', async () => {
    stubFetch(() => new Response('oops', { status: 500 }))
    expect(await submitDaily(submission, 'b')).toEqual({ ok: false, error: '500' })
  })

  it('네트워크 오류는 던지지 않고 ok:false', async () => {
    stubFetch(() => { throw new Error('offline') })
    expect(await submitDaily(submission, 'b')).toEqual({ ok: false, error: 'offline' })
  })
})

describe('fetchLeaderboard', () => {
  it('날짜와 기기 id를 쿼리로 보내고 항목·수를 받는다', async () => {
    const entries = [{
      name: 'A', distance: 7000, courseId: 'henley-steady-30', mode: 'classic', modeScore: 0, avgSplit: 130,
      at: '2026-11-10T01:00:00Z', mine: true,
    }]
    const calls = stubFetch(() => json({ entries, count: 1 }))
    const r = await fetchLeaderboard('2026-11-10')
    expect(r).toEqual({ entries, count: 1 })
    expect(calls[0]!.url).toBe(`/api/daily?date=2026-11-10&device=${deviceId()}`)
    expect(calls[0]!.init?.method).toBeUndefined()
  })

  it('entries가 없으면 빈 배열, count가 없으면 0', async () => {
    stubFetch(() => json({}))
    expect(await fetchLeaderboard('2026-11-10')).toEqual({ entries: [], count: 0 })
  })

  it('응답이 실패면 null', async () => {
    stubFetch(() => json({ error: 'nope' }, 503))
    expect(await fetchLeaderboard('2026-11-10')).toBeNull()
  })

  it('네트워크 오류도 null', async () => {
    stubFetch(() => { throw new Error('offline') })
    expect(await fetchLeaderboard('2026-11-10')).toBeNull()
  })
})
