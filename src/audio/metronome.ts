const MUTE_KEY = 'makeRowing.metronomeMuted'

/**
 * 평활화된 실제 스트로크 위상에서 catch(phase 0)를 한 번만 검출한다.
 * FTMS strokeCount가 늦게 들어와 위상이 중간에 0으로 보정되는 경우도 catch로 친다.
 */
export class CatchBeatDetector {
  private previousPhase: number | null = null

  update(phase: number, spm: number, active: boolean): boolean {
    if (!active || !Number.isFinite(phase) || !Number.isFinite(spm) || spm < 6) {
      this.previousPhase = null
      return false
    }

    const normalized = ((phase % 1) + 1) % 1
    if (this.previousPhase === null) {
      this.previousPhase = normalized
      return normalized < 0.035
    }

    const previous = this.previousPhase
    this.previousPhase = normalized
    // 정상적인 1→0 wrap 또는 실기기 strokeCount가 만든 catch 보정.
    return normalized < 0.065 && (previous > 0.72 || previous - normalized > 0.075)
  }

  reset() { this.previousPhase = null }
}

/** Web Audio로 실제 로잉 catch마다 짧은 클릭을 낸다. */
export class RowingMetronome {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private detector = new CatchBeatDetector()
  private muted = false

  constructor() {
    try { this.muted = localStorage.getItem(MUTE_KEY) === '1' } catch { /* 저장소 미지원 */ }
  }

  get isMuted() { return this.muted }
  get isSupported() { return typeof window !== 'undefined' && 'AudioContext' in window }

  /** iOS의 사용자 제스처 제한 때문에 시작 버튼의 첫 await 전에 호출해야 한다. */
  async unlock(): Promise<boolean> {
    try {
      if (!this.context) {
        this.context = new AudioContext({ latencyHint: 'interactive' })
        this.master = this.context.createGain()
        this.master.gain.value = this.muted ? 0 : 0.85
        this.master.connect(this.context.destination)
      }
      if (this.context.state === 'suspended') await this.context.resume()
      return this.context.state === 'running'
    } catch {
      // 소리가 지원되지 않아도 운동 시작 자체는 절대 막지 않는다.
      return false
    }
  }

  update(phase: number, spm: number, active: boolean) {
    const beat = this.detector.update(phase, spm, active)
    if (beat && !this.muted) this.click()
  }

  setMuted(muted: boolean) {
    this.muted = muted
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0') } catch { /* 저장소 미지원 */ }
    if (this.context && this.master) {
      const now = this.context.currentTime
      this.master.gain.cancelScheduledValues(now)
      this.master.gain.setValueAtTime(this.master.gain.value, now)
      this.master.gain.linearRampToValueAtTime(muted ? 0 : 0.85, now + 0.018)
      if (!muted && this.context.state === 'suspended') void this.context.resume().catch(() => {})
    }
  }

  toggleMuted() {
    this.setMuted(!this.muted)
    return this.muted
  }

  stop() { this.detector.reset() }

  dispose() {
    this.detector.reset()
    void this.context?.close().catch(() => {})
    this.context = null
    this.master = null
  }

  private click() {
    const context = this.context
    const master = this.master
    if (!context || !master || context.state !== 'running') return

    const now = context.currentTime
    const oscillator = context.createOscillator()
    const envelope = context.createGain()
    oscillator.type = 'triangle'
    oscillator.frequency.setValueAtTime(1_080, now)
    oscillator.frequency.exponentialRampToValueAtTime(620, now + 0.055)
    envelope.gain.setValueAtTime(0.0001, now)
    envelope.gain.exponentialRampToValueAtTime(0.17, now + 0.006)
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.06)
    oscillator.connect(envelope)
    envelope.connect(master)
    oscillator.start(now)
    oscillator.stop(now + 0.065)
    oscillator.onended = () => {
      oscillator.disconnect()
      envelope.disconnect()
    }
  }
}
