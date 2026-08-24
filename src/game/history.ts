/**
 * 세션 기록 저장소 (localStorage).
 *
 * 서버가 없으므로 브라우저에 남긴다. Bluefy에서도 동일하게 동작하지만,
 * 브라우저 데이터를 지우면 같이 지워진다는 점은 UI에서 알려준다.
 */

const KEY = 'makeRowing.history.v1'
const MAX = 200

export interface SessionRecord {
  id: string
  /** ISO 8601 */
  at: string
  courseId: string
  courseName: string
  courseType: string
  venue: string
  /** 코스 목표 시간 (초) */
  durationSec: number
  /** 기준 스플릿 (초/500m) */
  baseSplit: string | number
  /** 실제 기록 */
  elapsed: number
  distance: number
  avgSplit: number
  avgSpm: number
  avgPower: number
  strokeCount: number
  /** 페이스 보트 대비 최종 거리차 (m) */
  gap: number
  /** 완주 여부 */
  completed: boolean
  /** 1분 간격으로 솎아낸 스플릿 곡선 — 상세 화면 그래프용 */
  curve: { t: number; split: number }[]
}

export function loadHistory(): SessionRecord[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 최신순
    return parsed.filter(isRecord).sort((a, b) => b.at.localeCompare(a.at))
  } catch {
    return []   // 손상된 데이터 때문에 앱이 죽지 않게
  }
}

export function saveRecord(rec: SessionRecord): void {
  try {
    const all = [rec, ...loadHistory()].slice(0, MAX)
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // 저장 공간 초과 등 — 기록 실패가 세션을 망치면 안 된다
  }
}

export function deleteRecord(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadHistory().filter(r => r.id !== id)))
  } catch { /* 무시 */ }
}

export function clearHistory(): void {
  try { localStorage.removeItem(KEY) } catch { /* 무시 */ }
}

/** 같은 코스의 개인 최고 기록(거리 기준). 완주한 세션만 센다. */
export function personalBest(courseId: string, history = loadHistory()): SessionRecord | null {
  const done = history.filter(r => r.courseId === courseId && r.completed)
  if (!done.length) return null
  return done.reduce((a, b) => (b.distance > a.distance ? b : a))
}

/** 전체 요약 — 히스토리 화면 상단 */
export function totals(history = loadHistory()) {
  return {
    sessions: history.length,
    distance: history.reduce((a, r) => a + r.distance, 0),
    seconds: history.reduce((a, r) => a + r.elapsed, 0),
    strokes: history.reduce((a, r) => a + r.strokeCount, 0),
  }
}

function isRecord(x: unknown): x is SessionRecord {
  return !!x && typeof x === 'object'
    && typeof (x as SessionRecord).id === 'string'
    && typeof (x as SessionRecord).at === 'string'
    && typeof (x as SessionRecord).distance === 'number'
}

/** 초 단위 트랙을 1분 간격으로 솎아낸다 (저장 용량 절약) */
export function thinCurve(
  track: { t: number; split: number }[], everySec = 60,
): { t: number; split: number }[] {
  const out: { t: number; split: number }[] = []
  let bucket: number[] = []
  let bucketStart = 0
  for (const row of track) {
    if (row.t >= bucketStart + everySec) {
      if (bucket.length) {
        out.push({ t: bucketStart, split: round1(median(bucket)) })
      }
      bucketStart = Math.floor(row.t / everySec) * everySec
      bucket = []
    }
    if (isFinite(row.split) && row.split > 0 && row.split < 600) bucket.push(row.split)
  }
  if (bucket.length) out.push({ t: bucketStart, split: round1(median(bucket)) })
  return out
}

/** 평균 대신 중앙값 — 출발 직후의 비정상적으로 큰 스플릿에 끌려가지 않는다 */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}
function round1(v: number) { return Math.round(v * 10) / 10 }
