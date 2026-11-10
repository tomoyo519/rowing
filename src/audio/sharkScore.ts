import type { RowingMetronome } from './metronome'
import type { SharkState } from '../game/modes'

/**
 * 상어 추격 모드의 배경 음악 — 파일 없이 Web Audio로 만든다.
 *
 * 세 겹이다.
 * - 드론: 낮은 E(82Hz)와 살짝 어긋난 복제, 5도 위 B를 저역 필터로 눌러 어둡게 깔아 둔다. 레이스 내내 울린다.
 * - 모티프: 반음 두 개(E→F)를 첼로처럼 톱니파로 긁는다. 상어가 멀면 3초에 한 번, 코앞이면 0.45초에 한 번 —
 *   가까울수록 빨라지는 그 유명한 두 음이다. 덮치기 경고·덮치는 동안은 거리와 상관없이 빠르다.
 * - 라이저: 경고가 뜨면 2.5초 동안 노이즈가 밴드패스를 타고 올라간다.
 *
 * 메트로놈의 AudioContext·마스터 게인을 같이 쓴다 — 음소거 버튼 하나로 함께 꺼지고, iOS에서 컨텍스트가 둘이 되지 않는다.
 * 간격·세기 계산은 순수 함수(motifStep)라 테스트한다.
 */

const E2 = 82.41
const F2 = 87.31
const B2 = 123.47

export interface MotifStep {
  /** 다음 두 음까지의 간격 (초) */
  interval: number
  /** 음 하나의 세기 (마스터 앞 게인) */
  gain: number
}

/** 위험도(0 멀다 ~ 1 코앞)와 상어 상태로 모티프의 빠르기·세기를 정한다 */
export function motifStep(danger: number, state: SharkState): MotifStep {
  const d = Math.min(1, Math.max(0, danger))
  // 멀면 3초, 코앞이면 0.45초. 처음엔 천천히 좁혀지다 가까워질수록 급하게 빨라진다
  let interval = 3.0 - (3.0 - 0.45) * Math.pow(d, 1.4)
  if (state === 'surge') interval = Math.min(interval, 0.42)
  else if (state === 'warn') interval = Math.min(interval, 0.85)
  else if (state === 'retreat') interval = Math.max(interval, 2.2)
  const gain = 0.11 + 0.15 * d + (state === 'surge' ? 0.05 : 0)
  return { interval, gain }
}

export class SharkScore {
  private bus: GainNode | null = null
  private ctx: AudioContext | null = null
  private droneNodes: AudioNode[] = []
  private droneFilter: BiquadFilterNode | null = null
  private nextNoteAt = 0
  private lastState: SharkState = 'cruise'
  private active = false

  constructor(private host: RowingMetronome) {}

  /** 드론이 울리는 중인지 — 개발 훅·테스트용 */
  get isPlaying() { return this.active }

  /** 드론을 켠다. 컨텍스트가 아직 없으면(제스처 전) 다음 update에서 다시 시도한다 */
  start() {
    if (this.active) return
    const nodes = this.host.audioNodes
    if (!nodes || nodes.ctx.state !== 'running') return
    try {
      const { ctx, master } = nodes
      this.ctx = ctx
      const bus = ctx.createGain()
      bus.gain.setValueAtTime(0.0001, ctx.currentTime)
      bus.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 2.5)
      bus.connect(master)
      this.bus = bus

      // ── 드론 ──
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 240
      filter.Q.value = 1.2
      const droneGain = ctx.createGain()
      droneGain.gain.value = 0.07
      filter.connect(droneGain)
      droneGain.connect(bus)
      const voices: [number, OscillatorType, number][] = [
        [E2, 'sawtooth', 1], [E2 * 1.004, 'sawtooth', 0.8], [B2, 'triangle', 0.5], [E2 / 2, 'sine', 0.9],
      ]
      for (const [freq, type, level] of voices) {
        const osc = ctx.createOscillator()
        osc.type = type
        osc.frequency.value = freq
        const g = ctx.createGain()
        g.gain.value = level
        osc.connect(g)
        g.connect(filter)
        osc.start()
        this.droneNodes.push(osc, g)
      }
      // 필터가 아주 느리게 숨 쉰다 — 멈춰 있는 소리는 금방 배경으로 사라진다
      const lfo = ctx.createOscillator()
      lfo.type = 'sine'
      lfo.frequency.value = 0.07
      const lfoGain = ctx.createGain()
      lfoGain.gain.value = 70
      lfo.connect(lfoGain)
      lfoGain.connect(filter.frequency)
      lfo.start()
      this.droneNodes.push(lfo, lfoGain, filter, droneGain)
      this.droneFilter = filter
      this.nextNoteAt = ctx.currentTime + 1.2
      this.active = true
    } catch {
      this.teardown()
    }
  }

  /**
   * 매 프레임. 달리는 중이면 켜고, 위험도에 맞춰 두 음을 예약한다.
   * 음소거 중엔 마스터가 0이라 들리지 않지만 예약도 건너뛴다.
   */
  update(danger: number, state: SharkState, running: boolean) {
    if (!running) return
    if (!this.active) this.start()
    if (!this.active || !this.ctx || !this.bus) return
    const ctx = this.ctx
    if (ctx.state !== 'running' || this.host.isMuted) { this.lastState = state; return }

    if (state === 'warn' && this.lastState !== 'warn') this.riser()
    this.lastState = state

    // 드론도 가까워지면 조금 열린다 — 어둡던 소리가 거칠어진다
    this.droneFilter?.frequency.setTargetAtTime(240 + danger * 220, ctx.currentTime, 0.4)

    const step = motifStep(danger, state)
    // 한 프레임 뒤처져도 끊기지 않게 0.15초 앞서 예약한다
    while (this.nextNoteAt < ctx.currentTime + 0.15) {
      const t = Math.max(this.nextNoteAt, ctx.currentTime)
      const noteLen = Math.min(0.5, step.interval * 0.42)
      this.pluck(E2, t, noteLen, step.gain)
      this.pluck(F2, t + step.interval * 0.5, noteLen, step.gain * 0.92)
      this.nextNoteAt = t + step.interval
    }
  }

  /** 첼로를 긁는 듯한 낮은 음 하나 */
  private pluck(freq: number, at: number, len: number, gain: number) {
    const ctx = this.ctx
    const bus = this.bus
    if (!ctx || !bus) return
    try {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(freq, at)
      // 한 옥타브 위를 얇게 겹쳐 작은 스피커에서도 음정이 들린다
      const octave = ctx.createOscillator()
      octave.type = 'triangle'
      octave.frequency.setValueAtTime(freq * 2, at)
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(900, at)
      filter.frequency.exponentialRampToValueAtTime(260, at + len)
      filter.Q.value = 2
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, at)
      g.gain.exponentialRampToValueAtTime(gain, at + 0.035)
      g.gain.setValueAtTime(gain, at + len * 0.55)
      g.gain.exponentialRampToValueAtTime(0.0001, at + len)
      const octaveGain = ctx.createGain()
      octaveGain.gain.value = 0.35
      osc.connect(filter)
      octave.connect(octaveGain)
      octaveGain.connect(filter)
      filter.connect(g)
      g.connect(bus)
      osc.start(at)
      octave.start(at)
      osc.stop(at + len + 0.05)
      octave.stop(at + len + 0.05)
      osc.onended = () => {
        for (const node of [osc, octave, octaveGain, filter, g]) { try { node.disconnect() } catch { /* 무시 */ } }
      }
    } catch { /* 음 하나가 실패해도 루프는 계속 */ }
  }

  /** 경고 라이저 — 노이즈가 2.5초 동안 올라가다 덮치는 순간 끊긴다 */
  private riser() {
    const ctx = this.ctx
    const bus = this.bus
    if (!ctx || !bus) return
    try {
      const seconds = 2.6
      const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
      const source = ctx.createBufferSource()
      source.buffer = buffer
      const filter = ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.Q.value = 6
      const now = ctx.currentTime
      filter.frequency.setValueAtTime(180, now)
      filter.frequency.exponentialRampToValueAtTime(2200, now + seconds)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, now)
      g.gain.exponentialRampToValueAtTime(0.22, now + seconds - 0.1)
      g.gain.exponentialRampToValueAtTime(0.0001, now + seconds)
      source.connect(filter)
      filter.connect(g)
      g.connect(bus)
      source.start(now)
      source.stop(now + seconds + 0.02)
      source.onended = () => {
        for (const node of [source, filter, g]) { try { node.disconnect() } catch { /* 무시 */ } }
      }
    } catch { /* 무시 */ }
  }

  /** 레이스가 끝나거나 화면을 떠나면 1초에 걸쳐 잦아들고 정리한다 */
  stop() {
    if (!this.active) return
    const ctx = this.ctx
    const bus = this.bus
    const nodes = this.droneNodes
    this.active = false
    this.bus = null
    this.ctx = null
    this.droneNodes = []
    this.droneFilter = null
    if (!ctx || !bus) return
    try {
      const now = ctx.currentTime
      bus.gain.cancelScheduledValues(now)
      bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), now)
      bus.gain.exponentialRampToValueAtTime(0.0001, now + 1.0)
      window.setTimeout(() => {
        for (const node of nodes) {
          try { (node as OscillatorNode).stop?.() } catch { /* 이미 멈춤 */ }
          try { node.disconnect() } catch { /* 무시 */ }
        }
        try { bus.disconnect() } catch { /* 무시 */ }
      }, 1100)
    } catch {
      this.teardownNodes(nodes, bus)
    }
  }

  private teardown() {
    this.teardownNodes(this.droneNodes, this.bus)
    this.droneNodes = []
    this.bus = null
    this.ctx = null
    this.droneFilter = null
    this.active = false
  }

  private teardownNodes(nodes: AudioNode[], bus: GainNode | null) {
    for (const node of nodes) {
      try { (node as OscillatorNode).stop?.() } catch { /* 무시 */ }
      try { node.disconnect() } catch { /* 무시 */ }
    }
    try { bus?.disconnect() } catch { /* 무시 */ }
  }
}
