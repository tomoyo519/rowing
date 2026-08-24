import { FTMS_SERVICE, HEART_RATE_SERVICE, CHAR } from './ftms'
import { parseRowerData, hexdump } from './rowerData'
import type { RowerSample, RowerSource, SourceStatus } from '../types'

/** 원본 바이트를 콘솔에 찍어 실기기 페이로드를 검증하고 싶을 때 켠다. */
export const DEBUG_RAW = false

export class FtmsSource implements RowerSource {
  readonly name = 'FTMS 로잉머신'
  status: SourceStatus = 'idle'

  private device: BluetoothDevice | null = null
  private char: BluetoothRemoteGATTCharacteristic | null = null
  private sampleFns = new Set<(s: RowerSample) => void>()
  private statusFns = new Set<(s: SourceStatus, d?: string) => void>()
  private onDisconnected = () => this.setStatus('disconnected')

  /** ⚠️ 반드시 사용자 클릭 핸들러 안에서 호출할 것. Web Bluetooth는 user gesture를 요구한다. */
  async connect(): Promise<void> {
    if (!navigator.bluetooth) {
      this.setStatus('error', 'Web Bluetooth를 지원하지 않는 브라우저입니다 (iPad에서는 Bluefy를 쓰세요)')
      throw new Error('Web Bluetooth unavailable')
    }
    if (!window.isSecureContext) {
      this.setStatus('error', 'HTTPS가 아닙니다. Web Bluetooth는 secure context에서만 동작합니다')
      throw new Error('insecure context')
    }

    this.setStatus('connecting')
    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [FTMS_SERVICE] }],
        optionalServices: [HEART_RATE_SERVICE],
      })
      this.device.addEventListener('gattserverdisconnected', this.onDisconnected)

      const server = await this.device.gatt!.connect()
      const service = await server.getPrimaryService(FTMS_SERVICE)

      // Feature 캐릭터리스틱은 필수가 아니므로 실패해도 진행한다.
      try {
        const feat = await service.getCharacteristic(CHAR.FEATURE)
        const v = await feat.readValue()
        console.info('[FTMS] feature bits:', hexdump(v))
      } catch {
        console.info('[FTMS] feature 캐릭터리스틱 없음 — 무시하고 진행')
      }

      this.char = await service.getCharacteristic(CHAR.ROWER_DATA)
      this.char.addEventListener('characteristicvaluechanged', this.handleValue)
      await this.char.startNotifications()

      this.setStatus('connected', this.device.name ?? undefined)
    } catch (e) {
      this.setStatus('error', e instanceof Error ? e.message : String(e))
      throw e
    }
  }

  async disconnect(): Promise<void> {
    this.char?.removeEventListener('characteristicvaluechanged', this.handleValue)
    try { await this.char?.stopNotifications() } catch { /* 이미 끊긴 경우 */ }
    this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected)
    this.device?.gatt?.disconnect()
    this.char = null
    this.device = null
    this.setStatus('disconnected')
  }

  onSample(fn: (s: RowerSample) => void) {
    this.sampleFns.add(fn)
    return () => this.sampleFns.delete(fn)
  }

  onStatus(fn: (s: SourceStatus, d?: string) => void) {
    this.statusFns.add(fn)
    return () => this.statusFns.delete(fn)
  }

  private handleValue = (ev: Event) => {
    const view = (ev.target as BluetoothRemoteGATTCharacteristic).value
    if (!view) return
    if (DEBUG_RAW) console.debug('[FTMS] raw:', hexdump(view))

    const data = parseRowerData(view)
    if (data.truncated) console.warn('[FTMS] 페이로드가 flags보다 짧습니다:', hexdump(view))

    const sample: RowerSample = { ...data, at: performance.now() }
    for (const fn of this.sampleFns) fn(sample)
  }

  private setStatus(s: SourceStatus, detail?: string) {
    this.status = s
    for (const fn of this.statusFns) fn(s, detail)
  }
}
