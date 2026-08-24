/** FTMS Rower Data(0x2AD1)에서 뽑아낸 한 프레임. 기기마다 주는 필드가 달라 전부 optional. */
export interface RowerData {
  strokeRate?: number          // strokes/min
  strokeCount?: number
  avgStrokeRate?: number       // strokes/min
  totalDistance?: number       // m
  instantaneousPace?: number   // s / 500m
  averagePace?: number         // s / 500m
  instantaneousPower?: number  // W
  averagePower?: number        // W
  resistanceLevel?: number
  totalEnergy?: number         // kcal
  energyPerHour?: number       // kcal/h
  energyPerMinute?: number     // kcal/min
  heartRate?: number           // bpm
  metabolicEquivalent?: number // MET
  elapsedTime?: number         // s
  remainingTime?: number       // s

  /** 페이로드가 flags가 주장하는 것보다 짧아 파싱이 중간에 끊긴 경우 true. */
  truncated?: boolean
}

/** 타임스탬프가 붙은 샘플. 게임 루프가 실제로 소비하는 단위. */
export interface RowerSample extends RowerData {
  /** performance.now() 기준 ms */
  at: number
}

export type SourceStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'

/**
 * 데이터 공급원 공통 인터페이스.
 * 실제 BLE 기기(FtmsSource)와 시뮬레이터(MockSource)가 이걸 똑같이 구현하므로,
 * 게임 코드는 둘을 구분하지 않는다.
 */
export interface RowerSource {
  readonly name: string
  readonly status: SourceStatus
  connect(): Promise<void>
  disconnect(): Promise<void>
  onSample(fn: (s: RowerSample) => void): () => void
  onStatus(fn: (s: SourceStatus, detail?: string) => void): () => void
}
