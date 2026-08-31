import splashUrl from '../assets/audio/splash.mp3?url'
import duckUrl from '../assets/audio/duck.mp3?url'
import cheerUrl from '../assets/audio/cheer.mp3?url'
import attributionUrl from '../assets/audio/ATTRIBUTION.md?url'
import type { AmbientPresence } from '../three/world'
import type { StrokeCue } from './metronome'
import { RowingMetronome } from './metronome'

export type AmbientEventKind = 'splash' | 'duck' | 'cheer'
export const AMBIENT_AUDIO_ATTRIBUTION_URL = attributionUrl

export interface AmbientSchedulerInput {
  elapsedSec: number
  active: boolean
  strokeCue: StrokeCue | null
  presence: Readonly<AmbientPresence>
}

export interface AmbientEvent {
  kind: AmbientEventKind
  pan: number
  /** 같은 파일 안에서 매번 조금 다른 구간을 고르는 재현 가능한 값. */
  variant: number
}

function hashString(value: string) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededRandom(seed: string) {
  let state = hashString(seed)
  return () => {
    state += 0x6d2b79f5
    let n = state
    n = Math.imul(n ^ (n >>> 15), n | 1)
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61)
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296
  }
}

function range(random: () => number, min: number, max: number) {
  return min + random() * (max - min)
}

/**
 * DOM/Web Audio와 분리된 주변음 스케줄러.
 * 가까운 대상이 있을 때만 울리고 한 프레임에는 최대 한 소리만 고른다.
 */
export class AmbientEventScheduler {
  private random = seededRandom('rowing-ambience')
  private nextSplash = 0
  private nextDuck = 0
  private nextCheer = 0
  private quietUntil = 0

  constructor(seed = 'rowing-ambience') { this.reset(seed) }

  reset(seed: string) {
    this.random = seededRandom(seed)
    this.nextSplash = range(this.random, 4, 8)
    this.nextDuck = range(this.random, 15, 35)
    this.nextCheer = range(this.random, 25, 45)
    this.quietUntil = 0
  }

  update(input: AmbientSchedulerInput): AmbientEvent | null {
    const now = input.elapsedSec
    if (!input.active || !Number.isFinite(now) || now < this.quietUntil) return null

    const candidates: { kind: AmbientEventKind; due: number; pan: number }[] = []
    if (now >= this.nextSplash && input.strokeCue === 'pull') {
      candidates.push({ kind: 'splash', due: this.nextSplash, pan: 0 })
    }
    if (now >= this.nextDuck && input.presence.duck.distance <= 18) {
      candidates.push({
        kind: 'duck', due: this.nextDuck,
        pan: Math.max(-1, Math.min(1, input.presence.duck.pan)),
      })
    }
    if (now >= this.nextCheer && input.presence.spectator.distance <= 24) {
      candidates.push({
        kind: 'cheer', due: this.nextCheer,
        pan: Math.max(-1, Math.min(1, input.presence.spectator.pan)),
      })
    }
    if (candidates.length === 0) return null

    candidates.sort((a, b) => a.due - b.due)
    const selected = candidates[0]!
    switch (selected.kind) {
      case 'splash':
        this.nextSplash = now + range(this.random, 9, 16)
        this.quietUntil = now + 3.5
        break
      case 'duck':
        this.nextDuck = now + range(this.random, 45, 85)
        this.quietUntil = now + 5
        break
      case 'cheer':
        this.nextCheer = now + range(this.random, 60, 110)
        this.quietUntil = now + 7
        break
    }
    return { kind: selected.kind, pan: selected.pan, variant: this.random() }
  }
}

interface ClipSpec {
  url: string
  gain: number
  duration: number
  offsets: number[]
}

const CLIPS: Record<AmbientEventKind, ClipSpec> = {
  splash: {
    url: splashUrl, gain: 0.085, duration: 0.86,
    offsets: [2.5, 8.8, 15.6, 23.4, 31.8, 40.1],
  },
  duck: {
    url: duckUrl, gain: 0.072, duration: 1.35,
    offsets: [0.08, 0.75, 1.55],
  },
  cheer: {
    url: cheerUrl, gain: 0.055, duration: 1.9,
    offsets: [13.5, 20.5, 28.0, 34.0],
  },
}

function extractVariants(context: AudioContext, source: AudioBuffer, spec: ClipSpec) {
  return spec.offsets.map(offsetSec => {
    const start = Math.min(
      Math.floor(offsetSec * source.sampleRate),
      Math.max(0, source.length - 1),
    )
    const requested = Math.floor(spec.duration * source.sampleRate)
    const length = Math.max(1, Math.min(requested, source.length - start))
    const clip = context.createBuffer(source.numberOfChannels, length, source.sampleRate)
    for (let channel = 0; channel < source.numberOfChannels; channel++) {
      clip.getChannelData(channel).set(source.getChannelData(channel).subarray(start, start + length))
    }
    return clip
  })
}

/** RowingMetronome의 단일 iOS AudioContext를 공유하는 실제 샘플 재생기. */
export class AmbientSoundscape {
  private readonly scheduler = new AmbientEventScheduler()
  private buffers: Partial<Record<AmbientEventKind, AudioBuffer[]>> = {}
  private preparePromise: Promise<boolean> | null = null
  private preparedContext: AudioContext | null = null
  private activeSources = new Set<AudioBufferSourceNode>()

  constructor(private readonly metronome: RowingMetronome) {}

  reset(seed: string) {
    this.stopSources()
    this.scheduler.reset(seed)
  }

  /** 사용자 시작 제스처에서 열린 컨텍스트에 세 샘플을 비동기로 미리 디코딩한다. */
  prepare(): Promise<boolean> {
    const nodes = this.metronome.audioNodes
    if (!nodes) return Promise.resolve(false)
    if (this.preparedContext === nodes.ctx && this.preparePromise) return this.preparePromise

    this.preparedContext = nodes.ctx
    this.buffers = {}
    this.preparePromise = (async () => {
      let loadedAny = false
      // 긴 원본 셋을 동시에 PCM으로 펼치지 않도록 하나씩 디코딩한다.
      for (const kind of Object.keys(CLIPS) as AmbientEventKind[]) {
        try {
          const response = await fetch(CLIPS[kind].url)
          if (!response.ok) continue
          const data = await response.arrayBuffer()
          const decoded = await nodes.ctx.decodeAudioData(data)
          // 긴 원본 전체를 계속 들고 있지 않고 실제 재생할 짧은 구간만 복사해 iPad 메모리를 아낀다.
          this.buffers[kind] = extractVariants(nodes.ctx, decoded, CLIPS[kind])
          loadedAny = true
        } catch {
          // 한 샘플이 실패해도 레이스와 나머지 소리는 계속 동작한다.
        }
      }
      return loadedAny
    })()
    return this.preparePromise
  }

  update(input: AmbientSchedulerInput): AmbientEvent | null {
    const event = this.scheduler.update(input)
    if (event && !this.metronome.isMuted) this.play(event)
    return event
  }

  stop() { this.stopSources() }

  private play(event: AmbientEvent) {
    let source: AudioBufferSourceNode | null = null
    let gain: GainNode | null = null
    let panner: StereoPannerNode | null = null
    try {
      const nodes = this.metronome.audioNodes
      const variants = this.buffers[event.kind]
      if (!nodes || !variants?.length || nodes.ctx.state !== 'running') return

      const spec = CLIPS[event.kind]
      const index = Math.min(variants.length - 1, Math.floor(event.variant * variants.length))
      const buffer = variants[index]!
      const duration = Math.min(spec.duration, Math.max(0, buffer.duration))
      if (duration <= 0) return
      const now = nodes.ctx.currentTime
      source = nodes.ctx.createBufferSource()
      gain = nodes.ctx.createGain()
      try {
        if (typeof nodes.ctx.createStereoPanner === 'function') {
          panner = nodes.ctx.createStereoPanner()
          panner.pan.setValueAtTime(event.pan, now)
        }
      } catch {
        // 구형 Bluefy WebView는 StereoPanner가 선언만 있고 생성에 실패할 수 있다.
        panner = null
      }
      source.buffer = buffer
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.linearRampToValueAtTime(spec.gain, now + 0.025)
      gain.gain.setValueAtTime(spec.gain, now + Math.max(0.04, duration - 0.12))
      gain.gain.linearRampToValueAtTime(0.0001, now + duration)
      source.connect(gain)
      if (panner) {
        gain.connect(panner)
        panner.connect(nodes.master)
      } else {
        gain.connect(nodes.master)
      }
      const sourceNode = source
      const gainNode = gain
      const pannerNode = panner
      sourceNode.onended = () => {
        this.activeSources.delete(sourceNode)
        try { sourceNode.disconnect() } catch { /* 일부 WebView 구현 차이 */ }
        try { gainNode.disconnect() } catch { /* 일부 WebView 구현 차이 */ }
        try { pannerNode?.disconnect() } catch { /* 일부 WebView 구현 차이 */ }
      }
      this.activeSources.add(sourceNode)
      sourceNode.start(now, 0, duration)
      sourceNode.stop(now + duration + 0.02)
    } catch {
      // 주변음 하나가 실패해도 requestAnimationFrame 게임 루프는 절대 중단하지 않는다.
      if (source) this.activeSources.delete(source)
      try { source?.stop() } catch { /* 시작 전이거나 이미 끝남 */ }
      try { source?.disconnect() } catch { /* 일부 WebView 구현 차이 */ }
      try { gain?.disconnect() } catch { /* 일부 WebView 구현 차이 */ }
      try { panner?.disconnect() } catch { /* 일부 WebView 구현 차이 */ }
    }
  }

  private stopSources() {
    for (const source of this.activeSources) {
      try { source.stop() } catch { /* 이미 끝난 소스 */ }
    }
    this.activeSources.clear()
  }
}
