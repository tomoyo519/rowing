import type { RowingMetronome } from './metronome'

/**
 * 상황 알림음 + 음성 안내.
 *
 * 노를 젓는 동안에는 화면을 계속 볼 수 없다. 구간 전환·피드백·연결 끊김을 소리로 알린다.
 * 스트로크마다 울리는 메트로놈과는 역할이 다르지만 **오디오 그래프와 음소거 상태는 공유한다**
 * — 컨텍스트를 따로 만들면 iOS에서 한쪽이 잠기고, 음소거 버튼도 두 개가 되어버린다.
 */
export class AudioCues {
  private speechPrimed = false

  constructor(private host: RowingMetronome) {}

  /** ⚠️ 사용자 제스처 안에서. 메트로놈 unlock()과 같은 자리에서 부른다. */
  primeSpeech() {
    if (this.speechPrimed || !('speechSynthesis' in window)) return
    try {
      // iOS는 제스처 안에서 한 번 발화해야 이후 speak()가 먹는다
      const u = new SpeechSynthesisUtterance(' ')
      u.volume = 0
      window.speechSynthesis.speak(u)
      this.speechPrimed = true
    } catch { /* 소리가 없어도 운동은 굴러가야 한다 */ }
  }

  // ── 상황별 큐 ────────────────────────────────────────────

  countdown() { this.tone(660, 0.12, 0.5) }

  go() {
    this.tone(880, 0.16, 0.6)
    this.tone(1320, 0.26, 0.45, 0.09)
    this.say('시작')
  }

  /** @param harder 더 빡세지는 구간이면 올라가는 음, 아니면 내려가는 음 */
  segment(label: string, harder: boolean) {
    if (harder) {
      this.tone(520, 0.10, 0.5)
      this.tone(790, 0.16, 0.5, 0.09)
    } else {
      this.tone(620, 0.10, 0.45)
      this.tone(415, 0.20, 0.45, 0.09)
    }
    this.say(label)
  }

  /** 5분 피드백 — 제목만. 본문까지 읽으면 너무 길다. */
  feedback(title: string) {
    this.tone(700, 0.09, 0.4)
    this.say(title, 0.35)
  }

  finish() {
    this.tone(660, 0.16, 0.55)
    this.tone(880, 0.16, 0.55, 0.15)
    this.tone(1180, 0.42, 0.55, 0.30)
    this.say('완주했습니다', 0.7)
  }

  linkLost() {
    this.tone(320, 0.22, 0.55)
    this.tone(225, 0.32, 0.55, 0.18)
    this.say('연결이 끊겼습니다')
  }

  linkBack() {
    this.tone(600, 0.10, 0.5)
    this.tone(900, 0.16, 0.5, 0.09)
    this.say('다시 연결됐습니다')
  }

  /** 음소거 시 진행 중인 발화를 즉시 끊는다 */
  stopSpeech() {
    try { window.speechSynthesis?.cancel() } catch { /* 무시 */ }
  }

  // ── 저수준 ───────────────────────────────────────────────

  private tone(freq: number, dur: number, gain: number, delay = 0) {
    if (this.host.isMuted) return
    const nodes = this.host.audioNodes
    if (!nodes) return
    try {
      const { ctx, master } = nodes
      const t0 = ctx.currentTime + delay
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, t0)
      // 앞뒤를 부드럽게 열고 닫아야 딸깍 소리가 안 난다
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
      osc.connect(g)
      g.connect(master)
      osc.start(t0)
      osc.stop(t0 + dur + 0.02)
    } catch { /* 무시 */ }
  }

  private say(text: string, delaySec = 0.2) {
    if (this.host.isMuted || !text) return
    if (!('speechSynthesis' in window)) return
    window.setTimeout(() => {
      if (this.host.isMuted) return       // 대기 중에 음소거됐을 수 있다
      try {
        const u = new SpeechSynthesisUtterance(text)
        u.lang = 'ko-KR'
        u.rate = 1.05
        window.speechSynthesis.speak(u)
      } catch { /* 무시 */ }
    }, delaySec * 1000)
  }
}
