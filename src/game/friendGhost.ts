import { GhostTrack } from './ghost'
import type { SessionRecord } from './history'
import type { GameModeId } from './modes'

/**
 * 친구 고스트 — 기록 하나를 링크로 공유하면 상대가 같은 코스에서 내 고스트와 탄다.
 *
 * 요약 화면의 "공유 링크 만들기"가 곡선(1분 간격 스플릿)과 거리·시간을 /api/ghost에 올리고 짧은 id를 받는다.
 * 링크(?ghost=id)로 들어오면 코스 선택 화면에 배너가 뜨고, 그 코스를 타면 내 최고 기록 대신 친구가 옆 레인에 선다.
 */
export interface SharedGhost {
  id: string
  name: string
  courseId: string
  courseName: string
  distance: number
  elapsed: number
  avgSplit: number
  curve: { t: number; split: number }[]
  mode?: GameModeId
  at: string
}

export function sharedGhostIdFromUrl(search = location.search): string | null {
  const id = new URLSearchParams(search).get('ghost')
  return id && /^[A-Za-z0-9_-]{4,24}$/.test(id) ? id : null
}

export function isSharedGhost(x: unknown): x is SharedGhost {
  const g = x as SharedGhost
  return !!g && typeof g === 'object'
    && typeof g.id === 'string' && typeof g.courseId === 'string'
    && typeof g.distance === 'number' && typeof g.elapsed === 'number'
    && Array.isArray(g.curve)
}

export async function fetchSharedGhost(id: string): Promise<SharedGhost | null> {
  try {
    const res = await fetch(`/api/ghost?id=${encodeURIComponent(id)}`)
    if (!res.ok) return null
    const data: unknown = await res.json()
    return isSharedGhost(data) ? data : null
  } catch {
    return null
  }
}

export async function shareRecord(rec: SessionRecord, name: string): Promise<{ id: string; url: string } | null> {
  try {
    const body = {
      name, courseId: rec.courseId, courseName: rec.courseName, distance: rec.distance, elapsed: rec.elapsed,
      avgSplit: rec.avgSplit, curve: rec.curve, mode: rec.mode, at: rec.at,
    }
    const res = await fetch('/api/ghost', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-makerowing': '1' }, body: JSON.stringify(body),
    })
    if (!res.ok) return null
    const data = await res.json() as { id?: string }
    if (!data.id) return null
    return { id: data.id, url: `${location.origin}${location.pathname}?ghost=${data.id}` }
  } catch {
    return null
  }
}

/** 공유 고스트를 레이스의 GhostTrack으로. 이름은 record.courseName 자리에 두지 않는다 — 요약 문구에서 따로 쓴다 */
export function ghostTrackFrom(g: SharedGhost): GhostTrack {
  const record: SessionRecord = {
    id: `shared-${g.id}`, at: g.at, courseId: g.courseId, courseName: g.courseName, courseType: '', venue: '',
    durationSec: Math.round(g.elapsed), baseSplit: 0, elapsed: g.elapsed, distance: g.distance, avgSplit: g.avgSplit,
    avgSpm: 0, avgPower: 0, strokeCount: 0, gap: 0, completed: true, curve: g.curve, mode: g.mode,
  }
  return new GhostTrack(record)
}
