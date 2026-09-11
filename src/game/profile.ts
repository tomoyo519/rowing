/**
 * 코스 페이스 프로파일.
 *
 * 코스는 이제 일정한 페이스가 아니라 시간에 따라 강도가 변한다.
 * intensity는 **속도 배율** — 1.0이 기준 페이스, 1.1이면 10% 빠름.
 * (스플릿은 속도의 역수이므로 split = baseSplit / intensity)
 */

export interface IntervalStep {
  sec: number
  intensity: number
  label: string
}

export type PaceProfile =
  | { kind: 'steady' }
  /** 완만하게 빨랐다 느렸다를 반복 */
  | { kind: 'wave'; periodSec: number; amplitude: number }
  /** 처음부터 끝까지 한 방향으로만 변한다. 오르내림이 아예 없다. */
  | { kind: 'ramp'; from: number; to: number; overSec: number }
  /** 구간 반복. 총합이 코스 길이에 안 맞으면 앞에서부터 다시 반복한다. */
  | { kind: 'intervals'; pattern: IntervalStep[]; rampSec?: number }

/**
 * 구간 전환에 쓰는 기본 램프 (초).
 * 짧으면 페이스 보트 속도가 뚝뚝 끊겨서 타는 사람이 따라가기 나쁘다.
 * 다만 구간 자체가 짧으면 램프가 구간을 다 잡아먹으므로 비율로 제한한다.
 */
const DEFAULT_RAMP = 12
/** 램프가 구간에서 차지할 수 있는 최대 비율 */
const RAMP_MAX_RATIO = 0.3

/** 시각 t(초)에서의 속도 배율 */
export function intensityAt(p: PaceProfile, t: number): number {
  switch (p.kind) {
    case 'steady':
      return 1

    case 'wave':
      return 1 + p.amplitude * Math.sin((t / p.periodSec) * Math.PI * 2)

    case 'ramp': {
      const k = clamp(t / p.overSec, 0, 1)
      return lerp(p.from, p.to, k)
    }

    case 'intervals': {
      const total = patternTotal(p)
      if (total <= 0) return 1
      const local = ((t % total) + total) % total

      let acc = 0
      for (let i = 0; i < p.pattern.length; i++) {
        const step = p.pattern[i]!
        if (local < acc + step.sec) {
          const into = local - acc
          const prev = p.pattern[(i - 1 + p.pattern.length) % p.pattern.length]!
          const ramp = rampFor(p, prev, step)
          // 구간 시작부에서 이전 구간 강도로부터 램프.
          // 단 세션 맨 처음은 이전 구간이 없으므로 그대로 시작한다.
          if (into < ramp && t >= ramp) {
            return lerp(prev.intensity, step.intensity, into / ramp)
          }
          return step.intensity
        }
        acc += step.sec
      }
      return p.pattern[p.pattern.length - 1]!.intensity
    }
  }
}

/** 현재 구간 정보 — HUD 표시용 */
export interface StepInfo {
  label: string
  /** 이 구간이 끝나기까지 남은 시간 (초). 연속형이면 null */
  remaining: number | null
}

/** 이 전환에 쓸 램프 길이 (초) */
function rampFor(
  p: Extract<PaceProfile, { kind: 'intervals' }>,
  prev: IntervalStep, cur: IntervalStep,
): number {
  const want = p.rampSec ?? DEFAULT_RAMP
  return Math.min(want, prev.sec * RAMP_MAX_RATIO, cur.sec * RAMP_MAX_RATIO)
}

export function stepAt(p: PaceProfile, t: number): StepInfo {
  switch (p.kind) {
    case 'steady':
      return { label: '스테디', remaining: null }

    case 'ramp': {
      const rising = p.to > p.from
      const done = t >= p.overSec
      return {
        label: done ? (rising ? '마무리' : '쿨다운') : (rising ? '점진적 빌드' : '점진적 감속'),
        remaining: done ? null : p.overSec - t,
      }
    }

    case 'wave': {
      // 사인의 기울기로 지금 올라가는 중인지 내려가는 중인지 판단
      const rising = Math.cos((t / p.periodSec) * Math.PI * 2) > 0
      return { label: rising ? '페이스 올림' : '페이스 내림', remaining: null }
    }

    case 'intervals': {
      const total = patternTotal(p)
      if (total <= 0) return { label: '—', remaining: null }
      const local = ((t % total) + total) % total
      let acc = 0
      for (const step of p.pattern) {
        if (local < acc + step.sec) {
          return { label: step.label, remaining: acc + step.sec - local }
        }
        acc += step.sec
      }
      const last = p.pattern[p.pattern.length - 1]!
      return { label: last.label, remaining: 0 }
    }
  }
}

/** 다음에 올 구간. HUD가 "다음엔 이 페이스"를 미리 보여주는 데 쓴다. */
export interface NextStepInfo {
  label: string
  /** 다음 구간의 속도 배율 */
  intensity: number
  /** 다음 구간이 시작되기까지 남은 시간 (초) */
  startsIn: number
}

/**
 * 시각 t(초) 기준으로 다음 구간. 구간 개념이 없는 프로파일(steady, wave)이나
 * 코스가 끝나기 전에 다음 구간이 오지 않으면 null.
 */
export function nextStepAt(p: PaceProfile, t: number, durationSec = Infinity): NextStepInfo | null {
  let next: NextStepInfo | null = null
  switch (p.kind) {
    case 'steady':
    case 'wave':
      return null
    case 'ramp': {
      if (t >= p.overSec) return null
      const rising = p.to > p.from
      next = { label: rising ? '마무리' : '쿨다운', intensity: p.to, startsIn: p.overSec - t }
      break
    }
    case 'intervals': {
      const total = patternTotal(p)
      if (total <= 0) return null
      const local = ((t % total) + total) % total
      let acc = 0
      for (let i = 0; i < p.pattern.length; i++) {
        const step = p.pattern[i]!
        if (local < acc + step.sec) {
          const n = p.pattern[(i + 1) % p.pattern.length]!
          next = { label: n.label, intensity: n.intensity, startsIn: acc + step.sec - local }
          break
        }
        acc += step.sec
      }
      break
    }
  }
  if (next === null || t + next.startsIn >= durationSec) return null
  return next
}

/** 코스 구간 경계. 날씨처럼 "구간마다 하나"로 고정하는 요소가 쓴다. */
export interface ProfileSection {
  start: number
  end: number
  label: string
}

/**
 * 연속형 프로파일(스테디·빌드)은 고정 길이로 자른다. 5분 체크포인트와 같은 간격이라
 * 피드백이 뜰 때 구간도 함께 바뀐다.
 */
const CONTINUOUS_SECTION_SEC = 300

/**
 * 코스를 구간 목록으로 나눈다.
 *
 * - 인터벌은 스텝 경계가 그대로 구간 경계다. 스프린트처럼 아주 짧은 스텝은
 *   minSec가 찰 때까지 다음 스텝과 합쳐 한 사이클을 한 구간으로 본다.
 * - 웨이브는 반주기(올림/내림)마다 나뉜다.
 * - 스테디·빌드는 5분 단위로 자른다.
 *
 * 마지막 구간은 항상 코스 끝(durationSec)에서 끝난다.
 */
export function profileSections(
  p: PaceProfile, durationSec: number, minSec = 120,
): ProfileSection[] {
  const duration = Math.max(1, durationSec)
  const boundaries: { at: number; label: string }[] = []

  switch (p.kind) {
    case 'intervals': {
      const total = patternTotal(p)
      if (total <= 0) break
      let t = 0
      let sectionStart = 0
      let sectionLabel = p.pattern[0]!.label
      let index = 0
      while (t < duration) {
        const step = p.pattern[index % p.pattern.length]!
        const next = t + step.sec
        // 구간이 minSec를 채우면 여기서 끊고, 아니면 다음 스텝과 합친다.
        if (next - sectionStart >= minSec && next < duration) {
          boundaries.push({ at: sectionStart, label: sectionLabel })
          sectionStart = next
          sectionLabel = p.pattern[(index + 1) % p.pattern.length]!.label
        }
        t = next
        index++
      }
      boundaries.push({ at: sectionStart, label: sectionLabel })
      break
    }
    case 'wave': {
      const half = Math.max(minSec, p.periodSec / 2)
      for (let t = 0; t < duration; t += half) {
        boundaries.push({ at: t, label: stepAt(p, t + 1).label })
      }
      break
    }
    default:
      for (let t = 0; t < duration; t += CONTINUOUS_SECTION_SEC) {
        boundaries.push({ at: t, label: stepAt(p, t + 1).label })
      }
  }

  if (boundaries.length === 0) boundaries.push({ at: 0, label: stepAt(p, 1).label })

  const sections: ProfileSection[] = boundaries.map((b, i) => ({
    start: b.at,
    end: boundaries[i + 1]?.at ?? duration,
    label: b.label,
  }))
  // 코스 끝에 남은 자투리가 minSec보다 짧으면 앞 구간에 붙인다.
  const last = sections[sections.length - 1]!
  if (sections.length > 1 && last.end - last.start < minSec) {
    sections.pop()
    sections[sections.length - 1]!.end = duration
  }
  return sections
}

export function patternTotal(p: Extract<PaceProfile, { kind: 'intervals' }>): number {
  return p.pattern.reduce((a, s) => a + s.sec, 0)
}

/**
 * 프로파일 전체 구간에서 평균 속도 배율.
 * 예상 거리를 계산할 때 쓴다 — 인터벌 코스는 평균이 1이 아닐 수 있다.
 */
export function meanIntensity(p: PaceProfile, durationSec: number, samples = 400): number {
  if (p.kind === 'steady') return 1
  let sum = 0
  for (let i = 0; i < samples; i++) {
    sum += intensityAt(p, (i + 0.5) * (durationSec / samples))
  }
  return sum / samples
}

/** [t0, t1] 구간의 평균 속도 배율 — 피드백에서 최근 몇 분의 목표를 낼 때 쓴다 */
export function meanIntensityBetween(p: PaceProfile, t0: number, t1: number, samples = 120): number {
  if (t1 <= t0) return intensityAt(p, t0)
  if (p.kind === 'steady') return 1
  let sum = 0
  const step = (t1 - t0) / samples
  for (let i = 0; i < samples; i++) sum += intensityAt(p, t0 + (i + 0.5) * step)
  return sum / samples
}

/**
 * 실제로 '오르내리는' 정도.
 *
 * 단순 max-min은 잘못된 답을 준다 — 처음부터 끝까지 한 방향으로만 오르는 코스는
 * 범위가 넓어도 오르내림이 0이다. 그래서 방향이 **뒤집히는** 지점만 보고,
 * 뒤집힘 사이의 최대 낙차를 잰다. 단조 증가/감소면 0이 나온다.
 */
export function profileOscillation(p: PaceProfile, durationSec: number, samples = 480): number {
  if (p.kind === 'steady' || p.kind === 'ramp') return 0

  const v: number[] = []
  for (let i = 0; i < samples; i++) v.push(intensityAt(p, (i + 0.5) * (durationSec / samples)))

  // 극점(방향이 바뀌는 지점)만 추린다
  const extrema: number[] = [v[0]!]
  let dir = 0
  for (let i = 1; i < v.length; i++) {
    const d = Math.sign(v[i]! - v[i - 1]!)
    if (d === 0) continue
    if (dir !== 0 && d !== dir) extrema.push(v[i - 1]!)
    dir = d
  }
  extrema.push(v[v.length - 1]!)

  let max = 0
  for (let i = 1; i < extrema.length; i++) {
    max = Math.max(max, Math.abs(extrema[i]! - extrema[i - 1]!))
  }
  return max
}

/** 코스 전체에서 강도가 오르내리는 폭 (max - min). 카드 라벨용. */
export function profileSwing(p: PaceProfile, durationSec: number, samples = 240): number {
  const r = profileRange(p, durationSec, samples)
  return r.max - r.min
}

/** 코스 전체 강도 범위 */
export function profileRange(
  p: PaceProfile, durationSec: number, samples = 240,
): { min: number; max: number } {
  if (p.kind === 'steady') return { min: 1, max: 1 }
  let min = Infinity, max = -Infinity
  for (let i = 0; i < samples; i++) {
    const v = intensityAt(p, (i + 0.5) * (durationSec / samples))
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max }
}

/** 코스 카드에 그릴 미니 그래프용 샘플 (0~1 정규화된 y값) */
export function profileSamples(p: PaceProfile, durationSec: number, n = 72): number[] {
  const raw: number[] = []
  for (let i = 0; i < n; i++) raw.push(intensityAt(p, (i / (n - 1)) * durationSec))
  const lo = Math.min(...raw, 0.88)
  const hi = Math.max(...raw, 1.12)
  return raw.map(v => (v - lo) / (hi - lo || 1))
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t }
function clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v }
