/**
 * 코스마다 재현 가능한 완만한 강 중심선을 만든다.
 *
 * 전역 X는 코스 진행 거리, Z는 좌우 굽이이다. 렌더링에서는 현재 보트를
 * 원점과 정면에 고정한 뒤 이 중심선을 보트 기준 좌표로 변환한다.
 */
export interface CoursePath {
  primaryAmplitude: number
  primaryWavelength: number
  primaryPhase: number
  secondaryAmplitude: number
  secondaryWavelength: number
  secondaryPhase: number
}

export interface PathPoint {
  x: number
  z: number
  /** +X 진행축에서 잰 접선 각도 (radian). */
  heading: number
}

export interface LocalPathPoint extends PathPoint {
  /** 현재 보트가 바라보는 방향을 0으로 둔 상대 yaw. */
  yaw: number
}

/** 플레이어와 페이스메이커를 수로 중심에 대칭으로 둔다. */
export const PLAYER_LANE_OFFSET = 3.2
export const PACE_LANE_OFFSET = -3.2

function hashString(value: string) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededRandom(seed: string) {
  let state = hashString(seed)
  return () => {
    state += 0x6d2b79f5
    let n = state
    n = Math.imul(n ^ (n >>> 15), n | 1)
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61)
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296
  }
}

/** 같은 코스는 언제나 같은 굽이를 갖는다. */
export function createCoursePath(courseId: string): CoursePath {
  const random = seededRandom(`${courseId}:river-path`)
  return {
    primaryAmplitude: 14 + random() * 4,
    primaryWavelength: 450 + random() * 100,
    primaryPhase: random() * Math.PI * 2,
    secondaryAmplitude: 2 + random(),
    secondaryWavelength: 260 + random() * 70,
    secondaryPhase: random() * Math.PI * 2,
  }
}

/** 코스 거리 s에서의 전역 중심점과 접선. */
export function pathPointAt(path: CoursePath, s: number): PathPoint {
  const k1 = (Math.PI * 2) / path.primaryWavelength
  const k2 = (Math.PI * 2) / path.secondaryWavelength
  const a1 = s * k1 + path.primaryPhase
  const a2 = s * k2 + path.secondaryPhase
  const z = path.primaryAmplitude * Math.sin(a1)
    + path.secondaryAmplitude * Math.sin(a2)
  const dz = path.primaryAmplitude * k1 * Math.cos(a1)
    + path.secondaryAmplitude * k2 * Math.cos(a2)
  return { x: s, z, heading: Math.atan(dz) }
}

/** 중심선에서 법선 방향 lateral만큼 떨어진 전역 좌표. */
export function offsetPathPoint(path: CoursePath, s: number, lateral: number): PathPoint {
  const point = pathPointAt(path, s)
  return {
    x: point.x - Math.sin(point.heading) * lateral,
    z: point.z + Math.cos(point.heading) * lateral,
    heading: point.heading,
  }
}

/** -PI..PI 범위의 안정적인 각도 차. */
function angleDifference(a: number, b: number) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b))
}

/**
 * 현재 거리 originDistance의 중심과 접선을 원점/정면으로 둔 로컬 좌표.
 * along은 앞(+)/뒤(-) 거리, lateral은 강 중심에서 좌(+)/우(-) 오프셋이다.
 */
export function localPathPoint(
  path: CoursePath,
  originDistance: number,
  along: number,
  lateral = 0,
  originLateral = 0,
): LocalPathPoint {
  const origin = offsetPathPoint(path, originDistance, originLateral)
  const sample = offsetPathPoint(path, originDistance + along, lateral)
  const dx = sample.x - origin.x
  const dz = sample.z - origin.z
  const c = Math.cos(origin.heading)
  const s = Math.sin(origin.heading)

  return {
    x: dx * c + dz * s,
    z: -dx * s + dz * c,
    heading: sample.heading,
    yaw: angleDifference(sample.heading, origin.heading),
  }
}
