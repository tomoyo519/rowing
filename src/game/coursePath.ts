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

/** 플레이어는 오른쪽 레인, 페이스메이커는 노 끝이 닿지 않는 왼쪽 레인에 둔다. */
export const PLAYER_LANE_OFFSET = 3.2
// 정교해진 3m 폭의 노 끝까지 포함해도 서로 닿지 않도록 페이스 레인을 더 벌린다.
export const PACE_LANE_OFFSET = -4.0
/**
 * 고스트 레인. 플레이어를 가운데 두고 페이스 보트 반대편에 세운다.
 * 페이스 보트(-7.2)만큼 벌리면 세 척이 화면 폭을 넘어가서 조금 좁혔다.
 */
export const GHOST_LANE_OFFSET = 8.6

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
