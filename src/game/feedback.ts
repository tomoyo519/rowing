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
  /** 구간 평균 스플릿 − 목표 스플릿 (초). +면 느림 */
  delta: number
  /** 페이스 보트 대비 거리차 (m). +면 앞섬 */
  gap: number
}

/** 목표보다 이만큼(초) 빠르면/느리면 톤이 바뀐다 */
const BIG = 4.0
const SMALL = 1.5

/**
 * 노를 젓는 중에 읽고(그리고 음성으로 듣고) 힘이 나는 말. 느릴 때도 꾸짖지 않는다 —
 * 지금까지 버틴 걸 먼저 인정하고, 바로 할 수 있는 동작 하나(레이트·다리·캐치)를 준다.
 * 제목은 음성으로도 읽히므로 짧게, 이모지 없이.
 */
const LINES: Record<Tone, { title: string; body: string }[]> = {
  great: [
    { title: '완전 날아가요!', body: '목표보다 한참 빨라요. 오늘 컨디션 최고네요.' },
    { title: '이 페이스 미쳤어요!', body: '기록 갱신 냄새가 나요. 호흡만 지키면서 그대로!' },
    { title: '엔진 풀가동!', body: '페이스 보트가 따라오느라 바빠요. 정말 멋져요.' },
  ],
  good: [
    { title: '좋아요, 앞서가요!', body: '목표보다 살짝 빨라요. 지금 리듬 정말 좋아요.' },
    { title: '흐름 탔어요!', body: '편안하게 앞서는 중이에요. 이 느낌 그대로 가요.' },
    { title: '잘하고 있어요!', body: '꾸준함이 곧 실력이에요. 계속 이렇게만!' },
  ],
  onpace: [
    { title: '완벽한 페이스!', body: '목표에 딱 맞췄어요. 메트로놈 같은 리듬이에요.' },
    { title: '정확해요!', body: '계획한 그대로 가고 있어요. 프로처럼 타는 중!' },
    { title: '흔들림 제로!', body: '페이스 보트와 나란히. 이게 바로 실력이에요.' },
  ],
  push: [
    { title: '거의 다 왔어요!', body: '목표까지 몇 초 차이예요. 다리로 한 번 더 밀면 바로 붙어요.' },
    { title: '한 끗 차이!', body: '조금만 올리면 목표예요. 다음 10스트로크만 힘줘 봐요.' },
    { title: '할 수 있어요!', body: '금방 따라잡을 거리예요. 캐치부터 힘 있게!' },
  ],
  behind: [
    { title: '괜찮아요, 다시 가요!', body: '지금부터가 진짜예요. 레이트를 2만 올려 볼까요?' },
    { title: '숨 고르고 다시!', body: '여기까지 버틴 것만으로도 대단해요. 다음 5분은 한 단계만 올려 봐요.' },
    { title: '포기는 없어요!', body: '한 스트로크씩 다리로 강하게, 페이스를 조금씩 올려 봐요. 페이스 보트 금방 보여요.' },
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
 * @param elapsedSec 지금까지 저은 시간 (초). 있으면 "10분 돌파!"처럼 지나온 길을 먼저 짚어 준다
 */
export function buildFeedback(
  w: WindowStats, gap: number, idx: number, nextStep?: string, elapsedSec?: number,
): Feedback {
  const windowLabel = w.seconds >= 60
    ? `최근 ${Math.round(w.seconds / 60)}분`
    : `최근 ${Math.round(w.seconds)}초`
  const delta = w.split - w.targetSplit
  const tone = toneOf(delta)
  const pool = LINES[tone]
  const pick = pool[idx % pool.length]!

  let body = pick.body
  if (elapsedSec !== undefined && elapsedSec >= 60) {
    body = `${Math.round(elapsedSec / 60)}분 돌파! 최근 ${Math.round(w.distance).toLocaleString('ko-KR')}m를 저었어요. ${body}`
  }
  if (nextStep) body += ` 다음은 ‘${nextStep}’ 구간, 준비됐죠?`

  const sign = delta >= 0 ? '+' : '−'
  return {
    tone,
    title: pick.title,
    body,
    delta,
    gap,
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
