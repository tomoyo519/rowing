import { HEART_RATE_SERVICE } from './ftms'

/**
 * 심박 벨트·시계 (Bluetooth Heart Rate Service 0x180D) 연결.
 *
 * 로잉머신이 FTMS Rower Data에 심박을 싣지 않는 경우가 많다 — 기기에 벨트를 짝지어야만 싣거나, 아예 안 싣는다.
 * 그럴 때 벨트를 이 앱에 직접 붙이면 HUD의 심박 칸이 채워진다. 로잉머신과는 별개의 GATT 연결이다.
 */
export const HEART_RATE_MEASUREMENT = '00002a37-0000-1000-8000-00805f9b34fb'

export type HeartRateStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'
export type HeartRateScanMode = 'hr' | 'all'

/** 자동 재연결 최대 횟수. 벨트를 벗은 거라면 더 붙어 봐도 소용없다. */
const RECONNECT_MAX = 6

/**
 * Heart Rate Measurement(0x2A37) 파서.
 * 첫 바이트가 flags — bit0이 1이면 심박이 uint16, 0이면 uint8. 뒤에 에너지·RR 간격이 붙을 수 있지만 쓰지 않는다.
 * 0은 "센서가 아직 못 잼"(벨트가 피부에 안 닿음)이라 null로 돌려준다.
 */
export function parseHeartRateMeasurement(view: DataView): number | null {
  if (view.byteLength < 2) return null
  const flags = view.getUint8(0)
  const wide = (flags & 0x01) !== 0
  if (wide && view.byteLength < 3) return null
  const bpm = wide ? view.getUint16(1, true) : view.getUint8(1)
  return bpm > 0 && bpm < 300 ? bpm : null
}

export class HeartRateSensor {
  status: HeartRateStatus = 'idle'
  /** 선택한 기기 이름. 선택 전엔 빈 문자열 */
  name = ''

  private device: BluetoothDevice | null = null
  private char: BluetoothRemoteGATTCharacteristic | null = null
  private readingFns = new Set<(bpm: number, at: number) => void>()
  private statusFns = new Set<(s: HeartRateStatus, detail?: string) => void>()
  private manualDisconnect = false
  private reconnectTimer: number | null = null
  private reconnectAttempts = 0

  /** ⚠️ 반드시 사용자 클릭 핸들러 안에서 호출할 것. Web Bluetooth는 user gesture를 요구한다. */
  async connect(scanMode: HeartRateScanMode = 'hr'): Promise<void> {
    if (!navigator.bluetooth) throw new DOMException('Web Bluetooth API unavailable', 'NotSupportedError')
    this.manualDisconnect = false
    this.setStatus('connecting')
    try {
      // iPad(Bluefy)는 광고 필터 호환성이 들쭉날쭉해 전체 선택창이 더 안정적이다 — FTMS 연결과 같은 이유.
      this.device = await navigator.bluetooth.requestDevice(scanMode === 'all'
        ? { acceptAllDevices: true, optionalServices: [HEART_RATE_SERVICE] }
        : { filters: [{ services: [HEART_RATE_SERVICE] }] })
      this.name = this.device.name ?? '심박 센서'
      this.device.addEventListener('gattserverdisconnected', this.onDisconnected)
      await this.subscribe()
    } catch (error) {
      this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected)
      this.device = null
      this.char = null
      this.setStatus('error', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
      throw error
    }
  }

  async disconnect(): Promise<void> {
    this.manualDisconnect = true
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    try { await this.char?.stopNotifications() } catch { /* 이미 끊긴 연결 */ }
    this.char?.removeEventListener('characteristicvaluechanged', this.handleValue)
    this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected)
    try { this.device?.gatt?.disconnect() } catch { /* 이미 끊긴 연결 */ }
    this.char = null
    this.device = null
    this.setStatus('disconnected')
  }

  /** 심박 값이 올 때마다. at은 performance.now() 기준 ms — 로잉머신 샘플과 같은 시계다. */
  onReading(fn: (bpm: number, at: number) => void) {
    this.readingFns.add(fn)
    return () => this.readingFns.delete(fn)
  }

  onStatus(fn: (s: HeartRateStatus, detail?: string) => void) {
    this.statusFns.add(fn)
    return () => this.statusFns.delete(fn)
  }

  private async subscribe() {
    if (!this.device?.gatt) throw new DOMException('Selected device has no GATT server', 'NotSupportedError')
    const server = await this.device.gatt.connect()
    const service = await server.getPrimaryService(HEART_RATE_SERVICE)
    this.char = await service.getCharacteristic(HEART_RATE_MEASUREMENT)
    this.char.addEventListener('characteristicvaluechanged', this.handleValue)
    await this.char.startNotifications()
    this.reconnectAttempts = 0
    this.setStatus('connected', this.name)
  }

  private handleValue = (ev: Event) => {
    const view = (ev.target as BluetoothRemoteGATTCharacteristic).value
    if (!view) return
    const bpm = parseHeartRateMeasurement(view)
    if (bpm === null) return
    const at = performance.now()
    for (const fn of this.readingFns) fn(bpm, at)
  }

  private onDisconnected = () => {
    if (this.manualDisconnect || !this.device) {
      this.setStatus('disconnected')
      return
    }
    // 한 번 허용된 기기는 재연결에 사용자 제스처가 필요 없다. 벨트가 잠깐 멀어진 정도면 스스로 다시 붙는다.
    this.setStatus('reconnecting', this.name)
    this.scheduleReconnect()
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return
    const delay = Math.min(8000, 1000 * 2 ** this.reconnectAttempts)
    this.reconnectTimer = window.setTimeout(async () => {
      this.reconnectTimer = null
      if (this.manualDisconnect || !this.device) return
      this.reconnectAttempts += 1
      try {
        await this.subscribe()
      } catch {
        if (this.reconnectAttempts < RECONNECT_MAX) this.scheduleReconnect()
        else this.setStatus('disconnected', '다시 연결하지 못했습니다')
      }
    }, delay)
  }

  private setStatus(s: HeartRateStatus, detail?: string) {
    this.status = s
    for (const fn of this.statusFns) fn(s, detail)
  }
}
