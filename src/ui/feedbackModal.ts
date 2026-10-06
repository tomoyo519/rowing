import type { Feedback, Tone } from '../game/feedback'

/** 자동으로 닫히기까지 (ms). 노 젓는 중이라 손으로 못 닫는 걸 전제로 한다. */
const HOLD_MS = 6000

const ICONS: Record<Tone, string> = {
  great: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"/></svg>',
  good: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M4 7l4-4 4 4"/></svg>',
  onpace: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h10M3 10h10"/></svg>',
  push: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M4 9l4 4 4-4"/></svg>',
  behind: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M4 9l4 4 4-4"/></svg>',
}

/**
 * 5분 체크포인트 카드.
 * 게임은 계속 돌아간다 — 화면을 덮지 않고 위쪽 띠에 카드만 띄우고, 시간이 되면 스스로 닫힌다.
 * 핵심 숫자(목표 대비 초)를 가장 크게, 나머지는 타일로.
 */
export class FeedbackModal {
  private root: HTMLElement
  private card: HTMLElement
  private bar: HTMLElement
  private closeTimer: number | null = null
  private outTimer: number | null = null

  constructor() {
    this.root = document.getElementById('feedback')!
    this.card = document.getElementById('fb-card')!
    this.bar = document.getElementById('fb-bar')!
    // 탭하면 바로 닫힌다 (읽었으면 굳이 기다릴 필요 없음)
    this.card.addEventListener('click', () => this.hide())
  }

  show(fb: Feedback) {
    this.clearTimers()

    document.getElementById('fb-icon')!.innerHTML = ICONS[fb.tone]
    document.getElementById('fb-title')!.textContent = fb.title
    document.getElementById('fb-body')!.textContent = fb.body

    const hero = document.getElementById('fb-hero')!
    hero.replaceChildren()
    if (isFinite(fb.delta)) {
      const value = document.createElement('b')
      value.textContent = `${fb.delta >= 0 ? '+' : '−'}${Math.abs(fb.delta).toFixed(1)}`
      const unit = document.createElement('i')
      unit.textContent = 's'
      const word = document.createElement('span')
      word.textContent = Math.abs(fb.delta) < 1.5 ? '목표 페이스 그대로' : fb.delta > 0 ? '목표보다 느림' : '목표보다 빠름'
      hero.append(value, unit, word)
    }

    const stats = document.getElementById('fb-stats')!
    stats.replaceChildren()
    for (const [k, v] of fb.stats) {
      const tile = document.createElement('div')
      tile.className = 'tile'
      const key = document.createElement('div')
      key.className = 'k'
      key.textContent = k
      const value = document.createElement('div')
      value.className = 'v num'
      // '2:15.0 (+1.3s)' 처럼 괄호 안 차이는 히어로 숫자가 이미 보여준다 — 값만 남긴다
      value.textContent = v.replace(/\s*\([^)]*\)\s*$/, '')
      tile.append(key, value)
      stats.append(tile)
    }

    this.card.className = `fb-card ${fb.tone}`
    this.root.classList.add('on')

    // 남은 시간을 바로 보여준다 — 언제 닫힐지 알 수 있게
    this.bar.style.transition = 'none'
    this.bar.style.width = '100%'
    void this.bar.offsetWidth              // 리플로우 강제, 안 하면 트랜지션이 안 걸린다
    this.bar.style.transition = `width ${HOLD_MS}ms linear`
    this.bar.style.width = '0%'

    this.closeTimer = window.setTimeout(() => this.hide(), HOLD_MS)
  }

  hide() {
    if (!this.root.classList.contains('on')) return
    this.clearTimers()
    this.card.classList.add('out')
    this.outTimer = window.setTimeout(() => {
      this.root.classList.remove('on')
      this.card.classList.remove('out')
    }, 280)
  }

  /** 세션이 끝나면 남아있던 모달을 즉시 치운다 */
  reset() {
    this.clearTimers()
    this.root.classList.remove('on')
    this.card.classList.remove('out')
  }

  private clearTimers() {
    if (this.closeTimer !== null) window.clearTimeout(this.closeTimer)
    if (this.outTimer !== null) window.clearTimeout(this.outTimer)
    this.closeTimer = null
    this.outTimer = null
  }
}
