import type { Feedback } from '../game/feedback'

/** 자동으로 닫히기까지 (ms). 노 젓는 중이라 손으로 못 닫는 걸 전제로 한다. */
const HOLD_MS = 6000

/**
 * 5분 체크포인트 모달.
 * 게임은 계속 돌아간다 — 화면을 덮지 않고 카드만 띄우고, 시간이 되면 스스로 닫힌다.
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

    document.getElementById('fb-title')!.textContent = fb.title
    document.getElementById('fb-body')!.textContent = fb.body
    document.getElementById('fb-stats')!.innerHTML = fb.stats
      .map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`)
      .join('')

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
