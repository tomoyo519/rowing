import type { RowingMetronome } from './metronome'

/**
 * 콕스 음성 출력. 문구는 game/cox.ts가 정하고, 여기서는 메트로놈의 오디오 그래프와 음소거 상태를 같이 쓴다
 * (cues.ts와 같은 이유 — 컨텍스트를 따로 만들면 iOS에서 한쪽이 잠긴다).
 * 콕스는 구간 전환·피드백 음성보다 낮은 우선순위라, 다른 발화가 진행 중이면 끊지 않고 건너뛴다.
 */
export class CoxVoice {
  constructor(private host: RowingMetronome) {}

  /** 짧은 주목음 뒤에 한 줄. 다른 음성이 말하는 중이면 건너뛴다 */
  call(text: string, urgent = false) {
    if (this.host.isMuted || !text) return
    if (!('speechSynthesis' in window)) return
    try {
      if (window.speechSynthesis.speaking) return
    } catch { /* 지원 안 함 */ }
    this.tone(urgent ? 740 : 560, 0.08, 0.35)
    window.setTimeout(() => {
      if (this.host.isMuted) return
      try {
        const u = new SpeechSynthesisUtterance(text)
        u.lang = 'ko-KR'
        u.rate = 1.12
        u.pitch = 1.05
        window.speechSynthesis.speak(u)
      } catch { /* 무시 */ }
    }, 140)
  }

  /** 콤보 단계 소리 — 단계가 높을수록 음이 올라가고 길어진다 */
  combo(level: number) {
    const base = 520 + level * 90
    this.tone(base, 0.08, 0.4)
    this.tone(base * 1.25, 0.1, 0.4, 0.09)
    if (level >= 2) this.tone(base * 1.5, 0.16, 0.4, 0.18)
    if (level >= 4) this.tone(base * 2, 0.26, 0.4, 0.3)
  }

  /** 콤보가 끊겼다 — 낮게 내려가는 두 음 */
  comboBreak() {
    this.tone(400, 0.1, 0.3)
    this.tone(300, 0.18, 0.3, 0.1)
  }

  /** 파워 구간 시작 — 세 번 울리는 종 */
  zoneStart() {
    for (let i = 0; i < 3; i++) this.tone(880, 0.1, 0.45, i * 0.16)
  }

  zoneResult(success: boolean) {
    if (success) {
      this.tone(660, 0.1, 0.45)
      this.tone(880, 0.1, 0.45, 0.1)
      this.tone(1320, 0.3, 0.45, 0.2)
    } else {
      this.tone(440, 0.14, 0.35)
      this.tone(370, 0.26, 0.35, 0.14)
    }
  }

  /** 체크포인트 통과 — 맑은 한 음 */
  checkpoint(lead: boolean) {
    this.tone(lead ? 1046 : 784, 0.14, 0.4)
    this.tone(lead ? 1318 : 659, 0.2, 0.32, 0.12)
  }

  /** 코인 — 아주 짧은 두 음 */
  coin() {
    this.tone(1760, 0.05, 0.25)
    this.tone(2217, 0.08, 0.25, 0.05)
  }

  /** 심박 부스트 — 올라가는 글리산도 느낌의 네 음 */
  boost() {
    const notes = [523, 659, 784, 1046]
    notes.forEach((f, i) => this.tone(f, 0.12, 0.4, i * 0.07))
  }

  private tone(freq: number, dur: number, gain: number, delay = 0) {
    if (this.host.isMuted) return
    const nodes = this.host.audioNodes
    if (!nodes) return
    try {
      const { ctx, master } = nodes
      const t0 = ctx.currentTime + delay
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(freq, t0)
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
      osc.connect(g)
      g.connect(master)
      osc.start(t0)
      osc.stop(t0 + dur + 0.02)
      osc.onended = () => { try { osc.disconnect(); g.disconnect() } catch { /* 무시 */ } }
    } catch { /* 소리가 없어도 운동은 굴러간다 */ }
  }
}
