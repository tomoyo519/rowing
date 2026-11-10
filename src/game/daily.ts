import { COURSES, PACE_TIERS } from './courses'
import { GAME_MODES, type GameModeId } from './modes'
import { seededRandom } from './random'

/**
 * 오늘의 도전 — 날짜가 seed인 코스·모드·페이스를 모두가 같은 조건으로 탄다.
 *
 * 상어의 덮치는 시각, 파워 구간, 백조, 날씨까지 같은 seed에서 나오므로 정말 같은 레이스다.
 * 결과는 서버(/api/daily → Vercel Blob)에 올라가 하루치 순위표가 된다. 올리는 건 선택이고 별명만 보인다.
 */
export const NICKNAME_KEY = 'makeRowing.nickname.v1'
export const DEVICE_KEY = 'makeRowing.device.v1'
export const NICKNAME_MAX = 12

export interface DailyChallenge {
  /** YYYY-MM-DD (KST) */
  date: string
  courseId: string
  mode: GameModeId
  tierId: string
  /** Session의 weatherSeed 꼬리 — `${courseId}:${seed}`로 쓴다 */
  seed: string
  /** '11월 10일' */
  label: string
}

/** KST(UTC+9, 서머타임 없음) 기준 YYYY-MM-DD */
export function kstDateKey(nowMs = Date.now()): string {
  return new Date(nowMs + 9 * 3600 * 1000).toISOString().slice(0, 10)
}

export function dateLabel(dateKey: string): string {
  const [, m, d] = dateKey.split('-').map(Number)
  return `${m}월 ${d}일`
}

export function dailyChallenge(dateKey = kstDateKey()): DailyChallenge {
  const random = seededRandom(`daily:${dateKey}`)
  const course = COURSES[Math.floor(random() * COURSES.length)]!
  const r = random()
  const mode: GameModeId = r < 0.4 ? 'classic' : r < 0.7 ? 'shark' : 'chase'
  // 가볍게·전력은 빼고 스테디·강하게·레이스 중에서 — 순위표는 비슷한 페이스에서 재밌다
  const tiers = PACE_TIERS.filter(t => t.id === 'steady' || t.id === 'strong' || t.id === 'race')
  const tier = tiers[Math.floor(random() * tiers.length)] ?? PACE_TIERS[1]!
  return { date: dateKey, courseId: course.id, mode, tierId: tier.id, seed: `daily-${dateKey}`, label: dateLabel(dateKey) }
}

export function modeLabel(mode: GameModeId): string {
  return GAME_MODES.find(m => m.id === mode)?.label ?? '클래식'
}

export interface LeaderboardEntry {
  name: string
  distance: number
  courseId: string
  mode: GameModeId
  /** 상어: 잡힌 횟수, 추월: 추월 수 */
  modeScore: number
  /** 평균 스플릿 (초/500m) */
  avgSplit: number
  at: string
  /** 내 기기에서 올린 항목인지 — 서버가 deviceId로 표시 */
  mine?: boolean
}

export function loadNickname(): string {
  try { return sanitizeNickname(localStorage.getItem(NICKNAME_KEY) ?? '') } catch { return '' }
}

export function saveNickname(name: string) {
  try { localStorage.setItem(NICKNAME_KEY, sanitizeNickname(name)) } catch { /* 저장소 미지원 */ }
}

/** 제어문자·앞뒤 공백 제거, 길이 제한 */
export function sanitizeNickname(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, NICKNAME_MAX)
}

/** 이 브라우저를 구분하는 임의 id. 순위표에서 내 항목을 덮어쓰는 데만 쓴다 */
export function deviceId(): string {
  try {
    const saved = localStorage.getItem(DEVICE_KEY)
    if (saved && /^[0-9a-f]{16}$/.test(saved)) return saved
    const bytes = new Uint8Array(8)
    crypto.getRandomValues(bytes)
    const id = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
    localStorage.setItem(DEVICE_KEY, id)
    return id
  } catch {
    return 'anonymous-device'
  }
}

export interface DailySubmission {
  date: string
  name: string
  distance: number
  courseId: string
  mode: GameModeId
  modeScore: number
  avgSplit: number
}

/** 순위표에 올린다. 같은 기기의 더 좋은 기록만 남는다(서버 판단). 실패하면 false */
export async function submitDaily(s: DailySubmission, build: string): Promise<{ ok: boolean; rank?: number; error?: string }> {
  try {
    const res = await fetch('/api/daily', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-makerowing': '1' },
      body: JSON.stringify({ ...s, deviceId: deviceId(), build }),
    })
    const data = await res.json().catch(() => ({})) as { rank?: number; error?: string }
    return res.ok ? { ok: true, rank: data.rank } : { ok: false, error: data.error ?? String(res.status) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function fetchLeaderboard(date: string): Promise<{ entries: LeaderboardEntry[]; count: number } | null> {
  try {
    const res = await fetch(`/api/daily?date=${encodeURIComponent(date)}&device=${encodeURIComponent(deviceId())}`)
    if (!res.ok) return null
    const data = await res.json() as { entries?: LeaderboardEntry[]; count?: number }
    return { entries: Array.isArray(data.entries) ? data.entries : [], count: data.count ?? 0 }
  } catch {
    return null
  }
}
