import { splitToSpeed } from './physics'
import { meanIntensity, profileOscillation, profileRange, type PaceProfile } from './profile'

export interface Landmark {
  /** 코스 시작점으로부터의 거리 비율 0~1 */
  at: number
  name: string
  kind: 'bridge' | 'tower' | 'boathouse' | 'trees' | 'buoy' | 'castle' | 'windmill'
    | 'church' | 'townhouses' | 'footbridge' | 'suspension' | 'grandstand' | 'lighthouse'
}

export interface Venue {
  location: string
  palette: {
    skyTop: string
    skyBottom: string
    water: string
    waterDeep: string
    land: string
    landmark: string
  }
  landmarks: Landmark[]
}

export interface Course {
  id: string
  name: string
  /** 코스 유형 라벨 */
  type: '스테디' | '웨이브' | '인터벌' | '피라미드' | '스프린트' | '쓰레숄드' | '레이스'
      | '빌드' | '블록' | '테스트'
  /** 난이도. 고강도는 별도 그룹으로 묶는다 */
  level: '기본' | '고강도'
  durationSec: number
  venue: Venue
  profile: PaceProfile
  description: string
}

// ── 장소 ────────────────────────────────────────────────────
const HENLEY: Venue = {
  location: 'River Thames, Henley',
  palette: {
    skyTop: '#1b3a5c', skyBottom: '#e8a765', water: '#2d5a7a',
    waterDeep: '#16344a', land: '#1e3d2f', landmark: '#d9c9a3',
  },
  landmarks: [
    { at: 0.06, name: 'Temple Island', kind: 'trees' },
    { at: 0.13, name: 'Medmenham Castle', kind: 'castle' },
    { at: 0.21, name: 'Hambleden Footbridge', kind: 'footbridge' },
    { at: 0.30, name: 'Henley Bridge', kind: 'bridge' },
    { at: 0.37, name: 'Henley Town', kind: 'townhouses' },
    { at: 0.44, name: 'Remenham Club', kind: 'boathouse' },
    { at: 0.52, name: "St Mary's Church", kind: 'church' },
    { at: 0.58, name: 'Barrier Buoys', kind: 'buoy' },
    { at: 0.66, name: 'Upper Thames RC', kind: 'boathouse' },
    { at: 0.76, name: 'Marlow Suspension Bridge', kind: 'suspension' },
    { at: 0.84, name: 'Riverside Manor', kind: 'townhouses' },
    { at: 0.92, name: 'Fawley Court Tower', kind: 'tower' },
  ],
}

const BOSBAAN: Venue = {
  location: 'Bosbaan, Amsterdam',
  palette: {
    skyTop: '#132b45', skyBottom: '#7fa8c4', water: '#27506b',
    waterDeep: '#132f42', land: '#22402c', landmark: '#c2d3dd',
  },
  landmarks: [
    { at: 0.06, name: 'Start Tower', kind: 'tower' },
    { at: 0.14, name: 'De Molen', kind: 'windmill' },
    { at: 0.22, name: 'Muiderslot', kind: 'castle' },
    { at: 0.30, name: 'Amstel Footbridge', kind: 'footbridge' },
    { at: 0.38, name: 'Forest Bridge', kind: 'bridge' },
    { at: 0.46, name: 'Bosbaan Forest', kind: 'trees' },
    { at: 0.54, name: 'Canal Houses', kind: 'townhouses' },
    { at: 0.62, name: 'Grandstand', kind: 'grandstand' },
    { at: 0.70, name: '1000m Marker', kind: 'buoy' },
    { at: 0.78, name: 'IJ Suspension Bridge', kind: 'suspension' },
    { at: 0.86, name: 'Harbour Lighthouse', kind: 'lighthouse' },
    { at: 0.92, name: 'Boathouse Row', kind: 'boathouse' },
    { at: 0.97, name: 'Finish Tower', kind: 'tower' },
  ],
}

// ── 코스 ────────────────────────────────────────────────────
export const COURSES: Course[] = [
  // 30분
  {
    id: 'henley-steady-30',
    name: '헨리 스테디',
    type: '스테디',
    level: '기본',
    durationSec: 30 * 60,
    venue: HENLEY,
    profile: { kind: 'steady' },
    description: '처음부터 끝까지 같은 페이스. 기준 기록을 잡을 때 쓰세요.',
  },
  {
    id: 'henley-wave-30',
    name: '템스 웨이브',
    type: '웨이브',
    level: '기본',
    durationSec: 30 * 60,
    venue: HENLEY,
    profile: { kind: 'wave', periodSec: 330, amplitude: 0.06 },
    description: '5분 30초 주기로 완만하게 빨라졌다 느려집니다. 페이스 감각을 익히기 좋습니다.',
  },
  {
    id: 'henley-interval-30',
    name: '헨리 인터벌',
    type: '인터벌',
    level: '기본',
    durationSec: 30 * 60,
    venue: HENLEY,
    profile: {
      kind: 'intervals',
      pattern: [
        { sec: 180, intensity: 1.10, label: '푸시' },
        { sec: 120, intensity: 0.90, label: '회복' },
      ],
    },
    description: '3분 강하게 / 2분 회복을 6세트. 강약 대비가 뚜렷합니다.',
  },

  // 40분
  {
    id: 'bosbaan-steady-40',
    name: '보스반 스테디',
    type: '스테디',
    level: '기본',
    durationSec: 40 * 60,
    venue: BOSBAAN,
    profile: { kind: 'steady' },
    description: '흔들림 없는 40분. 지구력의 기준선입니다.',
  },
  {
    id: 'bosbaan-wave-40',
    name: '보스반 웨이브',
    type: '웨이브',
    level: '기본',
    durationSec: 40 * 60,
    venue: BOSBAAN,
    profile: { kind: 'wave', periodSec: 480, amplitude: 0.08 },
    description: '8분 주기로 길게 밀고 길게 쉽니다. 파도 타듯 이어집니다.',
  },
  {
    id: 'bosbaan-pyramid-40',
    name: '보스반 피라미드',
    type: '피라미드',
    level: '기본',
    durationSec: 40 * 60,
    venue: BOSBAAN,
    profile: {
      kind: 'intervals',
      pattern: [
        { sec: 300, intensity: 0.94, label: '워밍업' },
        { sec: 300, intensity: 0.98, label: '빌드 1' },
        { sec: 300, intensity: 1.02, label: '빌드 2' },
        { sec: 300, intensity: 1.06, label: '빌드 3' },
        { sec: 300, intensity: 1.10, label: '정상' },
        { sec: 300, intensity: 1.06, label: '하강 1' },
        { sec: 300, intensity: 1.00, label: '하강 2' },
        { sec: 300, intensity: 0.94, label: '쿨다운' },
      ],
    },
    description: '5분마다 한 계단씩 올라갔다 내려옵니다. 정확히 40분에 떨어집니다.',
  },

  // ── 변화가 거의 없는 코스 ────────────────────────────────
  {
    id: 'thames-easy-20',
    name: '템스 이지',
    type: '스테디',
    level: '기본',
    durationSec: 20 * 60,
    venue: HENLEY,
    profile: { kind: 'steady' },
    description: '가볍게 20분. 회복일이나 몸 푸는 날에 맞습니다.',
  },
  {
    id: 'thames-ripple-30',
    name: '템스 잔물결',
    type: '웨이브',
    level: '기본',
    durationSec: 30 * 60,
    venue: HENLEY,
    profile: { kind: 'wave', periodSec: 600, amplitude: 0.035 },
    description: '10분 주기로 아주 살짝만 흔들립니다. 거의 스테디에 가깝습니다.',
  },
  {
    id: 'henley-build-30',
    name: '헨리 롱 빌드',
    type: '빌드',
    level: '기본',
    durationSec: 30 * 60,
    venue: HENLEY,
    profile: { kind: 'ramp', from: 0.94, to: 1.06, overSec: 30 * 60 },
    description: '30분에 걸쳐 아주 천천히 빨라지기만 합니다. 오르내림이 없습니다.',
  },
  {
    id: 'bosbaan-negative-40',
    name: '보스반 네거티브',
    type: '빌드',
    level: '기본',
    durationSec: 40 * 60,
    venue: BOSBAAN,
    profile: { kind: 'ramp', from: 0.95, to: 1.08, overSec: 40 * 60 },
    description: '후반이 더 빠른 네거티브 스플릿. 한 방향으로만 올라갑니다.',
  },
  {
    id: 'bosbaan-blocks-40',
    name: '보스반 롱 블록',
    type: '블록',
    level: '기본',
    durationSec: 40 * 60,
    venue: BOSBAAN,
    profile: {
      kind: 'intervals',
      rampSec: 40,
      pattern: [
        { sec: 600, intensity: 0.96, label: '1블록' },
        { sec: 600, intensity: 1.02, label: '2블록' },
        { sec: 600, intensity: 1.06, label: '3블록' },
        { sec: 600, intensity: 0.98, label: '마무리' },
      ],
    },
    description: '10분짜리 블록 4개. 계단이 낮고 전환이 40초에 걸쳐 천천히 넘어갑니다.',
  },
  {
    id: 'henley-cruise-30',
    name: '헨리 크루즈',
    type: '인터벌',
    level: '기본',
    durationSec: 30 * 60,
    venue: HENLEY,
    profile: {
      kind: 'intervals',
      rampSec: 25,
      pattern: [
        { sec: 300, intensity: 1.06, label: '크루즈' },
        { sec: 60, intensity: 0.95, label: '이지' },
      ],
    },
    description: '5분 크루즈 / 1분 이지를 5세트. 인터벌이지만 대비를 낮춰 부드럽게 갑니다.',
  },

  // ── 고강도 ──────────────────────────────────────────────
  // 기본 코스가 편해졌을 때. 짧고 강하게 — 20분 이상 고강도는 회복이 안 된다.
  {
    id: 'thames-sprint-20',
    name: '템스 스프린트',
    type: '스프린트',
    level: '고강도',
    durationSec: 20 * 60,
    venue: HENLEY,
    profile: {
      kind: 'intervals',
      pattern: [
        { sec: 40, intensity: 1.28, label: '전력' },
        { sec: 80, intensity: 0.84, label: '회복' },
      ],
    },
    description: '40초 전력 / 80초 회복을 10세트. 무산소 구간까지 올라갑니다.',
  },
  {
    id: 'bosbaan-threshold-20',
    name: '보스반 쓰레숄드',
    type: '쓰레숄드',
    level: '고강도',
    durationSec: 20 * 60,
    venue: BOSBAAN,
    profile: {
      kind: 'intervals',
      pattern: [
        { sec: 240, intensity: 1.15, label: '쓰레숄드' },
        { sec: 60, intensity: 0.86, label: '회복' },
      ],
    },
    description: '4분 쓰레숄드 / 1분 회복을 4세트. 젖산 역치를 밀어올립니다.',
  },
  {
    id: 'henley-race-30',
    name: '헨리 레이스 시뮬',
    type: '레이스',
    level: '고강도',
    durationSec: 30 * 60,
    venue: HENLEY,
    profile: {
      kind: 'intervals',
      pattern: [
        { sec: 180, intensity: 0.90, label: '워밍업' },
        { sec: 30,  intensity: 1.32, label: '스타트' },
        { sec: 150, intensity: 1.12, label: '본 페이스' },
        { sec: 60,  intensity: 1.24, label: '스퍼트' },
        { sec: 180, intensity: 0.88, label: '회복' },
      ],
    },
    description: '스타트 폭발 → 본 페이스 → 마지막 스퍼트. 2000m 레이스 리듬을 5세트.',
  },
  {
    id: 'henley-test-20',
    name: '헨리 20분 테스트',
    type: '테스트',
    level: '고강도',
    durationSec: 20 * 60,
    venue: HENLEY,
    profile: { kind: 'ramp', from: 1.12, to: 1.12, overSec: 1 },
    description: '20분 내내 한 페이스로 밀어붙이는 벤치마크. 강도는 높지만 오르내림은 없습니다.',
  },
]

export function courseById(id: string): Course {
  return COURSES.find(c => c.id === id) ?? COURSES[0]!
}

/**
 * 오르내림이 이 이하면 '완만'으로 친다.
 * 범위(max-min)가 아니라 방향이 뒤집힐 때의 낙차 기준이라,
 * 한 방향으로만 변하는 빌드 코스는 범위가 넓어도 여기 들어온다.
 *
 * 0.115인 이유: 10포인트짜리 블록 전환(롱 블록)과 11포인트짜리 크루즈 인터벌은
 * 전환이 느긋해서 체감상 완만한데, 0.10으로 자르면 부동소수점 오차까지 겹쳐
 * 둘 다 '변화 있음'으로 밀려난다. 12포인트인 웨이브와는 사이가 벌어진다.
 */
const GENTLE_OSCILLATION = 0.115

export interface CourseGroup {
  label: string
  note: string
  tone: 'gentle' | 'varied' | 'hard'
  courses: Course[]
}

/**
 * 선택 화면 그룹핑.
 *
 * 길이가 아니라 **페이스가 얼마나 오르내리는지**로 묶는다.
 * 코스가 많아지면 "30분짜리가 뭐가 있나"보다 "얼마나 흔들리나"가 고르는 기준이 되기 때문.
 * 길이는 카드에 붙어 있다.
 */
export function courseGroups(): CourseGroup[] {
  const byDuration = (a: Course, b: Course) => a.durationSec - b.durationSec
  const base = COURSES.filter(c => c.level === '기본')

  const gentle = base
    .filter(c => profileOscillation(c.profile, c.durationSec) <= GENTLE_OSCILLATION)
    .sort(byDuration)
  const varied = base
    .filter(c => profileOscillation(c.profile, c.durationSec) > GENTLE_OSCILLATION)
    .sort(byDuration)
  const hard = COURSES.filter(c => c.level === '고강도').sort(byDuration)

  const groups: CourseGroup[] = []
  if (gentle.length) groups.push({
    label: '완만', tone: 'gentle',
    note: '페이스가 거의 일정하거나 한 방향으로만 천천히 변합니다.',
    courses: gentle,
  })
  if (varied.length) groups.push({
    label: '변화 있음', tone: 'varied',
    note: '구간마다 강약이 오갑니다. 전환은 천천히 넘어갑니다.',
    courses: varied,
  })
  if (hard.length) groups.push({
    label: '고강도', tone: 'hard',
    note: '기본 코스가 편해졌을 때. 짧고 강하게 갑니다.',
    courses: hard,
  })
  return groups
}

/** 카드에 표시할 강도 범위 — "94~106%" */
export function courseRangeLabel(c: Course): string {
  const { min, max } = profileRange(c.profile, c.durationSec)
  const lo = Math.round(min * 100), hi = Math.round(max * 100)
  return lo === hi ? `${lo}% 고정` : `${lo}~${hi}%`
}

export function projectedDistance(course: Course, targetSplit: number): number {
  const mean = meanIntensity(course.profile, course.durationSec)
  return splitToSpeed(targetSplit) * mean * course.durationSec
}

export interface PaceTier {
  id: string
  label: string
  split: number
  hint: string
}

/**
 * 페이스 보트가 달리는 기준 스플릿.
 * 페이스 보트는 "최소한 이 속도는 타야 한다"는 기준선이라, 실제 로어가 따라붙어야 할 만큼
 * 빠르게 잡았다. 예전 값(2:45~1:58)은 조금만 저어도 페이스 보트가 뒤로 사라져 기준이 되지 못했다.
 */
export const PACE_TIERS: PaceTier[] = [
  { id: 'easy',   label: '가볍게', split: 150, hint: '2:30 · 대화가 가능한 강도' },
  { id: 'steady', label: '스테디', split: 135, hint: '2:15 · 유산소 지구력 구간' },
  { id: 'strong', label: '강하게', split: 125, hint: '2:05 · 호흡이 가빠지는 구간' },
  { id: 'race',   label: '레이스', split: 115, hint: '1:55 · 대회 페이스' },
  { id: 'max',    label: '전력',   split: 105, hint: '1:45 · 한계까지 밀어붙이는 구간' },
]
