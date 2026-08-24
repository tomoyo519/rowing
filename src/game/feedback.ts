/**
 * 5분 체크포인트 피드백.
 *
 * 최근 구간의 실제 스플릿을 그 구간이 요구한 목표 스플릿과 비교해서
 * 한 줄 코칭을 만든다. 순수 함수라 메시지 규칙만 따로 테스트할 수 있다.
 */

export type Tone = 'great' | 'good' | 'onpace' | 'push' | 'behind'

export interface WindowStats {
  /** 구간 평균 스플릿 (초/500m) */
  split: number
  /** 구간이 요구한 목표 스플릿 (초/500m) */
  targetSplit: number
  spm: number
  power: number
  /** 구간에서 나아간 거리 (m) */
  distance: number
  /** 구간 길이 (초) */
  seconds: number
}

export interface Feedback {
  tone: Tone
  title: string
  body: string
  stats: [string, string][]
}

/** 목표보다 이만큼(초) 빠르면/느리면 톤이 바뀐다 */
const BIG = 4.0
const SMALL = 1.5

const LINES: Record<Tone, { title: string; body: string }[]> = {
  great: [
    { title: '아주 좋습니다', body: '목표보다 한참 앞서 있어요. 이 페이스 유지해보세요.' },
    { title: '훌륭해요', body: '지금 흐름이면 기록 나옵니다. 호흡만 잃지 마세요.' },
    { title: '기세 좋아요', body: '목표를 크게 앞섰습니다. 무리 아니면 계속 밀어보세요.' },
  ],
  good: [
    { title: '잘 하고 있어요', body: '목표보다 조금 앞섭니다. 이대로 유지하세요.' },
    { title: '좋은 페이스', body: '살짝 앞서 있어요. 리듬 그대로 가면 됩니다.' },
    { title: '순조롭습니다', body: '목표 위에서 안정적으로 타고 있어요.' },
  ],
  onpace: [
    { title: '정확히 목표 페이스', body: '흔들림 없이 잘 타고 있습니다.' },
    { title: '페이스 그대로', body: '목표에 딱 맞게 가고 있어요. 좋습니다.' },
    { title: '안정적입니다', body: '계획한 대로 진행 중이에요.' },
  ],
  push: [
    { title: '조금만 더', body: '목표보다 살짝 처졌어요. 한 단계만 올려보세요.' },
    { title: '페이스 올릴 때', body: '조금 느려졌습니다. 다리로 더 밀어보세요.' },
    { title: '살짝 아쉬워요', body: '목표에서 조금 벌어졌어요. 따라붙을 수 있습니다.' },
  ],
  behind: [
    { title: '더 빨리 타야 해요', body: '목표 페이스에서 많이 벌어졌습니다.' },
    { title: '속도를 올리세요', body: '지금부터 따라붙어야 합니다. 레이트부터 높여보세요.' },
    { title: '집중해봅시다', body: '목표보다 많이 느립니다. 한 스트로크씩 강하게.' },
  ],
}

export function toneOf(delta: number): Tone {
  // delta = 실제 - 목표. 스플릿은 작을수록 빠르므로 음수가 앞선 것.
  if (delta <= -BIG) return 'great'
  if (delta <= -SMALL) return 'good'
  if (delta < SMALL) return 'onpace'
  if (delta < BIG) return 'push'
  return 'behind'
}

/**
 * @param w   최근 구간 통계
 * @param gap 페이스 보트 대비 거리차 (m). +면 앞섬
 * @param idx 몇 번째 체크포인트인지 — 문구를 돌려쓰기 위한 인덱스
 * @param nextStep 다음에 올 구간 이름 (있으면 예고를 덧붙인다)
 */
export function buildFeedback(
  w: WindowStats, gap: number, idx: number, nextStep?: string,
): Feedback {
  const windowLabel = w.seconds >= 60
    ? `최근 ${Math.round(w.seconds / 60)}분`
    : `최근 ${Math.round(w.seconds)}초`
  const delta = w.split - w.targetSplit
  const tone = toneOf(delta)
  const pool = LINES[tone]
  const pick = pool[idx % pool.length]!

  let body = pick.body
  if (nextStep) body += ` 다음은 ‘${nextStep}’ 구간입니다.`

  const sign = delta >= 0 ? '+' : '−'
  return {
    tone,
    title: pick.title,
    body,
    stats: [
      [windowLabel, fmt(w.split)],
      ['목표', `${fmt(w.targetSplit)} (${sign}${Math.abs(delta).toFixed(1)}s)`],
      ['페이스 보트', `${gap >= 0 ? '+' : ''}${Math.round(gap)}m`],
    ],
  }
}

function fmt(sec: number): string {
  if (!isFinite(sec) || sec <= 0 || sec > 600) return '--:--'
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}
