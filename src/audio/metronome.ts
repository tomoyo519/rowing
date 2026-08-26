const MUTE_KEY = 'makeRowing.metronomeMuted'

export type StrokeCue = 'pull' | 'return'

/**
 * 한 스트로크에서 두 시점을 검출한다.
 *
 * - pull: 캐치에서 당기기를 시작할 때
 * - return: 드라이브를 마치고 원위치로 돌아가기 시작할 때
 *
 * FTMS의 늦은 strokeCount가 예상 캐치 직후 phase를 다시 0으로 보정해도
 * 같은 pull 소리가 두 번 나지 않도록, 사이클 중반을 지난 뒤에만 다음 pull을 허용한다.
 */
export class StrokeCueDetector {
  private previousPhase: number | null = null
  private pullLocked = true
  private returnPlayed = true

  update(phase: number, spm: number, driveFraction: number, active: boolean): StrokeCue | null {
    if (
      !active
      || !Number.isFinite(phase)
      || !Number.isFinite(spm)
      || !Number.isFinite(driveFraction)
      || spm < 6
    ) {
      this.reset()
      return null
    }

    const normalized = ((phase % 1) + 1) % 1
    const recoveryAt = Math.min(0.58, Math.max(0.25, driveFraction))
    if (this.previousPhase === null) {
      this.previousPhase = normalized
      // 운동 도중 소리를 켜도 현재 동작 중간에서 갑자기 울리지 않고 다음 경계부터 맞춘다.
      this.pullLocked = normalized < 0.58
      this.returnPlayed = normalized >= recoveryAt
      return null
    }

    const previous = this.previousPhase
    this.previousPhase = normalized

    // 사이클 후반까지 왔을 때만 다음 pull을 연다. 예상 wrap 직후 들어온 늦은
    // strokeCount 보정(예: 0.18 → 0)은 아직 잠겨 있어 중복 소리를 내지 않는다.
    if (normalized >= 0.58) this.pullLocked = false

    const movedToCatch = normalized < 0.075
      && (previous > 0.72 || previous - normalized > 0.12)
    if (movedToCatch && !this.pullLocked) {
      this.pullLocked = true
      this.returnPlayed = false
      return 'pull'
    }

    const crossedRecovery = normalized > previous
      && previous < recoveryAt
      && normalized >= recoveryAt
    if (crossedRecovery && !this.returnPlayed) {
      this.returnPlayed = true
      return 'return'
    }

    return null
  }

  reset() {
    this.previousPhase = null
    this.pullLocked = true
    this.returnPlayed = true
  }
}

/** 실제 로잉 동작에 맞춰 당길 때 `똑`, 돌아갈 때 `딱` 소리를 낸다. */
export class RowingMetronome {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private detector = new StrokeCueDetector()
  private muted = false

  constructor() {
    try { this.muted = localStorage.getItem(MUTE_KEY) === '1' } catch { /* 저장소 미지원 */ }
  }

  get isMuted() { return this.muted }

  /**
   * 이벤트 큐(AudioCues)가 같은 오디오 그래프를 쓰도록 노출한다.
   * 컨텍스트를 두 개 만들면 iOS에서 하나가 잠기는 일이 생긴다.
   */
  get audioNodes(): { ctx: AudioContext; master: GainNode } | null {
    return this.context && this.master ? { ctx: this.context, master: this.master } : null
  }
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

  update(phase: number, spm: number, driveFraction: number, active: boolean) {
    const cue = this.detector.update(phase, spm, driveFraction, active)
    if (cue && !this.muted) this.click(cue)
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

  private click(cue: StrokeCue) {
    const context = this.context
    const master = this.master
    if (!context || !master || context.state !== 'running') return

    const now = context.currentTime
    const oscillator = context.createOscillator()
    const envelope = context.createGain()
    const isPull = cue === 'pull'
    const duration = isPull ? 0.052 : 0.03

    oscillator.type = 'triangle'
    // 고정된 두 음높이와 짧은 감쇠를 써서 기존의 `삐융` 같은 전자음 느낌을 없앤다.
    oscillator.frequency.setValueAtTime(isPull ? 520 : 980, now)
    envelope.gain.setValueAtTime(0.0001, now)
    envelope.gain.exponentialRampToValueAtTime(isPull ? 0.13 : 0.085, now + 0.003)
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration)
    oscillator.connect(envelope)
    envelope.connect(master)
    oscillator.start(now)
    oscillator.stop(now + duration + 0.006)
    oscillator.onended = () => {
      oscillator.disconnect()
      envelope.disconnect()
    }
  }
}
