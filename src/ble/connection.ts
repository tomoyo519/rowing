import { FTMS_SERVICE, HEART_RATE_SERVICE, CHAR } from './ftms'
import { parseRowerData, hexdump } from './rowerData'
import type { RowerSample, RowerSource, SourceStatus } from '../types'

/** 원본 바이트를 콘솔에 찍어 실기기 페이로드를 검증하고 싶을 때 켠다. */
export const DEBUG_RAW = false

export type BleDiagnosticLevel = 'info' | 'success' | 'warning' | 'error'

export interface BleDiagnosticEntry {
  at: number
  level: BleDiagnosticLevel
  code: string
  message: string
  detail?: string
  errorName?: string
}

export interface BluetoothErrorDiagnosis {
  name: string
  summary: string
  suggestion: string
  technical: string
}

/** DOMException 이름을 사용자가 바로 행동할 수 있는 설명으로 바꾼다. */
export function diagnoseBluetoothError(error: unknown): BluetoothErrorDiagnosis {
  const name = error instanceof Error ? error.name : 'UnknownError'
  const technical = error instanceof Error ? error.message : String(error)
  switch (name) {
    case 'NotFoundError':
      return {
        name, technical,
        summary: '호환되는 로잉머신을 선택하지 못했습니다.',
        suggestion: '기기 선택 창을 닫았다면 다시 시도하세요. 목록이 비었다면 로잉머신 전원과 FTMS 지원 여부를 확인하세요.',
      }
    case 'SecurityError':
      return {
        name, technical,
        summary: '브라우저가 Bluetooth 사용을 보안상 차단했습니다.',
        suggestion: 'HTTPS 주소인지, 브라우저의 Bluetooth 권한이 허용됐는지 확인하세요.',
      }
    case 'NotAllowedError':
      return {
        name, technical,
        summary: 'Bluetooth 권한이 허용되지 않았습니다.',
        suggestion: '브라우저 설정에서 이 사이트의 Bluetooth 권한을 허용한 뒤 다시 눌러주세요.',
      }
    case 'NetworkError':
      return {
        name, technical,
        summary: '로잉머신과 Bluetooth 통신을 시작하지 못했습니다.',
        suggestion: '다른 앱의 연결을 끊고 로잉머신을 껐다 켠 뒤 가까이에서 다시 시도하세요.',
      }
    case 'InvalidStateError':
      return {
        name, technical,
        summary: 'Bluetooth 기기 상태가 연결 가능한 상태가 아닙니다.',
        suggestion: '기존 연결을 해제하고 로잉머신과 브라우저를 다시 시작해 보세요.',
      }
    case 'NotSupportedError':
      return {
        name, technical,
        summary: '이 브라우저 또는 기기가 필요한 Bluetooth 기능을 지원하지 않습니다.',
        suggestion: 'iPad에서는 Web Bluetooth를 지원하는 브라우저를 사용하고, 로잉머신이 FTMS Rower Data를 제공하는지 확인하세요.',
      }
    default:
      return {
        name, technical,
        summary: technical || '알 수 없는 Bluetooth 오류가 발생했습니다.',
        suggestion: '아래 단계별 로그를 복사해 기기 모델명과 함께 확인해 주세요.',
      }
  }
}

export class FtmsSource implements RowerSource {
  readonly name = 'FTMS 로잉머신'
  status: SourceStatus = 'idle'

  private device: BluetoothDevice | null = null
  private char: BluetoothRemoteGATTCharacteristic | null = null
  private sampleFns = new Set<(s: RowerSample) => void>()
  private statusFns = new Set<(s: SourceStatus, d?: string) => void>()
  private diagnosticFns = new Set<(entry: BleDiagnosticEntry) => void>()
  private packetCount = 0
  private firstPacketTimer: number | null = null
  private connecting = false
  private manualDisconnect = false
  private stage = 'idle'
  private onDisconnected = () => {
    this.clearFirstPacketTimer()
    this.log(
      this.manualDisconnect ? 'info' : 'error',
      this.manualDisconnect ? 'disconnect.manual' : 'disconnect.unexpected',
      this.manualDisconnect ? '사용자가 Bluetooth 연결을 종료했습니다.' : '로잉머신 연결이 예기치 않게 끊어졌습니다.',
      this.device?.name ?? undefined,
    )
    this.setStatus('disconnected')
  }

  /** ⚠️ 반드시 사용자 클릭 핸들러 안에서 호출할 것. Web Bluetooth는 user gesture를 요구한다. */
  async connect(): Promise<void> {
    if (this.connecting || this.status === 'connected') {
      this.log('warning', 'connect.duplicate', '이미 연결 중이거나 연결되어 있어 중복 요청을 건너뜁니다.')
      return
    }
    this.connecting = true
    this.manualDisconnect = false
    this.packetCount = 0
    this.stage = 'preflight'
    this.log('info', 'attempt.start', 'Bluetooth 연결 시도를 시작합니다.')
    this.log(
      navigator.bluetooth ? 'success' : 'error',
      'preflight.bluetooth',
      navigator.bluetooth ? 'Web Bluetooth API를 확인했습니다.' : 'Web Bluetooth API가 없습니다.',
      navigator.userAgent,
    )
    this.log(
      window.isSecureContext ? 'success' : 'error',
      'preflight.secure',
      window.isSecureContext ? 'HTTPS 보안 연결을 확인했습니다.' : 'HTTPS 보안 연결이 아닙니다.',
      location.origin,
    )

    if (!navigator.bluetooth) {
      const error = new DOMException('Web Bluetooth API unavailable', 'NotSupportedError')
      this.fail(error)
      this.connecting = false
      throw error
    }
    if (!window.isSecureContext) {
      const error = new DOMException('Web Bluetooth requires a secure context', 'SecurityError')
      this.fail(error)
      this.connecting = false
      throw error
    }

    this.setStatus('connecting')
    try {
      this.stage = 'chooser'
      this.log('info', 'chooser.open', '기기 선택 창을 요청했습니다. FTMS 로잉머신만 표시됩니다.')
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [FTMS_SERVICE] }],
        optionalServices: [HEART_RATE_SERVICE],
      })
      this.log(
        'success', 'chooser.selected',
        `기기를 선택했습니다: ${this.device.name ?? '이름 없는 기기'}`,
      )
      this.device.addEventListener('gattserverdisconnected', this.onDisconnected)

      this.stage = 'gatt'
      this.log('info', 'gatt.connect.start', 'GATT 서버 연결을 시작합니다.')
      if (!this.device.gatt) throw new DOMException('Selected device has no GATT server', 'NotSupportedError')
      const server = await this.device.gatt!.connect()
      this.log('success', 'gatt.connect.ok', 'GATT 서버에 연결했습니다.')

      this.stage = 'ftms-service'
      this.log('info', 'service.ftms.start', 'FTMS 서비스(0x1826)를 찾고 있습니다.')
      const service = await server.getPrimaryService(FTMS_SERVICE)
      this.log('success', 'service.ftms.ok', 'FTMS 서비스(0x1826)를 찾았습니다.')

      // Feature 캐릭터리스틱은 필수가 아니므로 실패해도 진행한다.
      try {
        this.log('info', 'feature.read.start', 'FTMS Feature(0x2ACC)를 읽고 있습니다.')
        const feat = await service.getCharacteristic(CHAR.FEATURE)
        const v = await feat.readValue()
        this.log('success', 'feature.read.ok', 'FTMS 기능 정보를 읽었습니다.', hexdump(v))
        console.info('[FTMS] feature bits:', hexdump(v))
      } catch (error) {
        this.log(
          'warning', 'feature.read.skipped',
          'FTMS 기능 정보는 읽지 못했지만 선택 항목이므로 계속합니다.',
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        )
        console.info('[FTMS] feature 캐릭터리스틱 없음 — 무시하고 진행')
      }

      this.stage = 'rower-characteristic'
      this.log('info', 'rower-char.start', 'Rower Data 특성(0x2AD1)을 찾고 있습니다.')
      this.char = await service.getCharacteristic(CHAR.ROWER_DATA)
      this.log('success', 'rower-char.ok', 'Rower Data 특성(0x2AD1)을 찾았습니다.')
      this.char.addEventListener('characteristicvaluechanged', this.handleValue)

      this.stage = 'notifications'
      this.log('info', 'notifications.start', '로잉 데이터 알림 구독을 시작합니다.')
      await this.char.startNotifications()
      this.log('success', 'notifications.ok', '알림 구독을 시작했습니다. 첫 데이터를 기다립니다.')
      this.firstPacketTimer = window.setTimeout(() => {
        if (this.packetCount === 0 && this.status === 'connected') {
          this.log(
            'warning', 'packet.timeout',
            '연결은 됐지만 8초 동안 로잉 데이터가 오지 않았습니다.',
            '로잉머신에서 손잡이를 몇 번 당겨 화면을 깨우고, 다른 운동 앱의 연결을 해제하세요.',
          )
        }
      }, 8_000)

      this.stage = 'connected'
      this.setStatus('connected', this.device.name ?? undefined)
      this.log('success', 'connected', 'Bluetooth 연결 절차를 완료했습니다.')
    } catch (e) {
      this.fail(e)
      await this.cleanupAfterFailure()
      throw e
    } finally {
      this.connecting = false
    }
  }

  async disconnect(): Promise<void> {
    this.manualDisconnect = true
    this.clearFirstPacketTimer()
    this.log('info', 'cleanup.start', 'Bluetooth 연결을 정리합니다.')
    this.char?.removeEventListener('characteristicvaluechanged', this.handleValue)
    try {
      await this.char?.stopNotifications()
      if (this.char) this.log('success', 'cleanup.notifications.ok', '데이터 알림 구독을 해제했습니다.')
    } catch (error) {
      this.log(
        'warning', 'cleanup.notifications.skipped',
        '알림 구독 해제는 실패했지만 연결 정리를 계속합니다.',
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      )
    }
    this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected)
    this.device?.gatt?.disconnect()
    this.char = null
    this.device = null
    this.setStatus('disconnected')
    this.log('success', 'cleanup.done', 'Bluetooth 연결 정리를 마쳤습니다.')
  }

  onSample(fn: (s: RowerSample) => void) {
    this.sampleFns.add(fn)
    return () => this.sampleFns.delete(fn)
  }

  onStatus(fn: (s: SourceStatus, d?: string) => void) {
    this.statusFns.add(fn)
    return () => this.statusFns.delete(fn)
  }

  onDiagnostic(fn: (entry: BleDiagnosticEntry) => void) {
    this.diagnosticFns.add(fn)
    return () => this.diagnosticFns.delete(fn)
  }

  private handleValue = (ev: Event) => {
    const view = (ev.target as BluetoothRemoteGATTCharacteristic).value
    if (!view) return
    if (DEBUG_RAW) console.debug('[FTMS] raw:', hexdump(view))

    const data = parseRowerData(view)
    this.packetCount += 1
    const flags = view.byteLength >= 2 ? `0x${view.getUint16(0, true).toString(16).padStart(4, '0')}` : '읽을 수 없음'
    if (this.packetCount === 1) {
      this.clearFirstPacketTimer()
      this.log(
        'success', 'packet.first',
        `첫 로잉 데이터를 받았습니다 (${view.byteLength} bytes).`,
        `flags=${flags}, fields=${Object.keys(data).filter(key => key !== 'truncated').join(', ') || '없음'}`,
      )
    }
    if (data.truncated) {
      // 반복되는 잘린 패킷이 로그를 가득 채우지 않게 첫 번과 이후 20개마다 남긴다.
      if (this.packetCount === 1 || this.packetCount % 20 === 0) {
        this.log(
          'warning', 'packet.truncated',
          '패킷 길이가 FTMS flags가 표시한 데이터보다 짧습니다.',
          `received=${view.byteLength} bytes, flags=${flags}`,
        )
      }
      console.warn('[FTMS] 페이로드가 flags보다 짧습니다:', hexdump(view))
    }

    const sample: RowerSample = { ...data, at: performance.now() }
    for (const fn of this.sampleFns) fn(sample)
  }

  private setStatus(s: SourceStatus, detail?: string) {
    this.status = s
    for (const fn of this.statusFns) fn(s, detail)
  }

  private log(
    level: BleDiagnosticLevel,
    code: string,
    message: string,
    detail?: string,
    errorName?: string,
  ) {
    const entry: BleDiagnosticEntry = { at: Date.now(), level, code, message, detail, errorName }
    for (const fn of this.diagnosticFns) {
      try { fn(entry) } catch { /* 진단 UI 오류가 실제 연결을 막으면 안 된다. */ }
    }
  }

  private fail(error: unknown) {
    const diagnosis = diagnoseBluetoothError(error)
    this.log(
      'error', 'error', `${this.stage} 단계에서 실패: ${diagnosis.summary}`,
      `${diagnosis.suggestion} | 기술 정보: ${diagnosis.technical}`,
      diagnosis.name,
    )
    this.setStatus('error', `${diagnosis.summary} ${diagnosis.suggestion}`)
  }

  private clearFirstPacketTimer() {
    if (this.firstPacketTimer !== null) window.clearTimeout(this.firstPacketTimer)
    this.firstPacketTimer = null
  }

  private async cleanupAfterFailure() {
    this.clearFirstPacketTimer()
    this.char?.removeEventListener('characteristicvaluechanged', this.handleValue)
    try { await this.char?.stopNotifications() } catch { /* 부분 연결 상태일 수 있다. */ }
    this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected)
    this.device?.gatt?.disconnect()
    this.char = null
    this.device = null
    this.log('info', 'cleanup.failure', '실패한 연결의 부분 상태를 정리했습니다.')
  }
}
