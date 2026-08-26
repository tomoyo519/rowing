import { personalBest, type SessionRecord } from './history'

/**
 * 지난 기록을 되살려 나란히 달리게 하는 고스트.
 *
 * 저장된 곡선은 1분 간격으로 솎여 있어서(용량 절약) 그대로는 거칠다.
 * 그래서 각 구간의 스플릿으로 거리를 적분한 뒤,
 * **최종 거리가 실제 기록과 정확히 일치하도록 스케일을 맞춘다.**
 * 중간은 근사지만 끝점은 정확해서, 마지막에 이겼는지 졌는지가 어긋나지 않는다.
 */
export class GhostTrack {
  readonly totalDistance: number
  readonly totalTime: number
  /** 구간 경계 시각 (초). 오름차순. */
  private ts: number[]
  /** 각 경계에서의 누적 거리 (m) */
  private ds: number[]

  constructor(readonly record: SessionRecord) {
    this.totalDistance = Math.max(0, record.distance)
    this.totalTime = Math.max(1, record.elapsed)
    const built = build(record, this.totalTime, this.totalDistance)
    this.ts = built.ts
    this.ds = built.ds
  }

  /** 세션 시작 t초 시점에 고스트가 가 있던 거리 (m) */
  distanceAt(t: number): number {
    if (!(t > 0)) return 0
    if (t >= this.totalTime) return this.totalDistance

    // 구간 이진 탐색
    let lo = 0, hi = this.ts.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (this.ts[mid]! <= t) lo = mid
      else hi = mid
    }
    const t0 = this.ts[lo]!, t1 = this.ts[hi]!
    const d0 = this.ds[lo]!, d1 = this.ds[hi]!
    if (t1 <= t0) return d1
    return d0 + (d1 - d0) * ((t - t0) / (t1 - t0))
  }

  /** 고스트가 이 시점에 내던 스플릿 (초/500m) — HUD 표시용 */
  splitAt(t: number): number {
    const dt = 5
    const d = this.distanceAt(t + dt) - this.distanceAt(Math.max(0, t - dt))
    const span = Math.min(t + dt, this.totalTime) - Math.max(0, t - dt)
    if (d <= 0 || span <= 0) return Infinity
    return (span / d) * 500
  }
}

function build(record: SessionRecord, totalTime: number, totalDistance: number) {
  const pts = (record.curve ?? [])
    .filter(p => Number.isFinite(p.t) && Number.isFinite(p.split) && p.split > 0 && p.split < 600)
    .sort((a, b) => a.t - b.t)

  // 곡선이 없거나 너무 짧으면 평균 속도로 균등하게 달린 것으로 본다
  if (pts.length < 2) {
    return { ts: [0, totalTime], ds: [0, totalDistance] }
  }

  const ts: number[] = [0]
  const ds: number[] = [0]
  let d = 0

  for (let i = 0; i < pts.length; i++) {
    // 첫 구간은 0초부터 시작한 것으로 본다 (첫 샘플이 0초가 아닐 수 있음)
    const tStart = i === 0 ? 0 : pts[i]!.t
    const tEnd = i + 1 < pts.length ? pts[i + 1]!.t : totalTime
    const dur = Math.max(0, Math.min(tEnd, totalTime) - tStart)
    if (dur <= 0) continue
    d += (500 / pts[i]!.split) * dur
    ts.push(Math.min(tEnd, totalTime))
    ds.push(d)
  }

  // 마지막 경계가 총 시간에 못 미치면 마지막 속도로 채운다
  const lastT = ts[ts.length - 1]!
  if (lastT < totalTime) {
    const lastSplit = pts[pts.length - 1]!.split
    d += (500 / lastSplit) * (totalTime - lastT)
    ts.push(totalTime)
    ds.push(d)
  }

  // 끝점을 실제 기록에 맞춘다
  const k = d > 0 ? totalDistance / d : 0
  return { ts, ds: ds.map(x => x * k) }
}

/** 이 코스의 개인 최고 기록으로 고스트를 만든다. 없으면 null. */
export function loadGhost(courseId: string): GhostTrack | null {
  const pb = personalBest(courseId)
  if (!pb || pb.distance <= 0 || pb.elapsed <= 0) return null
  return new GhostTrack(pb)
}
