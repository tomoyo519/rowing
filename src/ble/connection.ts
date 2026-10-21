import { FTMS_SERVICE, CHAR, HEART_RATE_SERVICE } from './ftms'
import { parseRowerData, hexdump, describeRowerData } from './rowerData'
import { HEART_RATE_MEASUREMENT, parseHeartRateMeasurement } from './heartRate'
import type { RowerSample, RowerSource, SourceStatus } from '../types'

/** 원본 바이트를 콘솔에 찍어 실기기 페이로드를 검증하고 싶을 때 켠다. */
export const DEBUG_RAW = false
/** 이 간격(패킷 수)마다 파싱된 값을 진단 로그에 남긴다. 2Hz 기기면 1분. */
export const PACKET_SAMPLE_EVERY = 120

export type BleDiagnosticLevel = 'info' | 'success' | 'warning' | 'error'
export type BleScanMode = 'ftms' | 'all'

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

function getNativeErrorDetails(error: unknown): { name: string; technical: string } {
  if (error instanceof Error) return { name: error.name || 'Error', technical: error.message }
  if (typeof error !== 'object' || error === null) {
    return { name: 'UnknownError', technical: String(error) }
  }

  const record = error as Record<string, unknown>
  const nativeName = typeof record.name === 'string' && record.name ? record.name : 'UnknownError'
  const parts: string[] = []
  if (typeof record.message === 'string' && record.message) parts.push(record.message)
  if ('code' in record) parts.push(`code=${String(record.code)}`)
  try {
    const serialized = JSON.stringify(error)
    if (serialized && serialized !== '{}') parts.push(`raw=${serialized}`)
  } catch {
    parts.push(`raw=${Object.prototype.toString.call(error)}`)
  }
  return {
    name: nativeName,
    technical: parts.join(' | ') || Object.prototype.toString.call(error),
  }
}

function formatNativeError(error: unknown): string {
  const detail = getNativeErrorDetails(error)
  return `${detail.name}: ${detail.technical}`
}

/** DOMException 이름을 사용자가 바로 행동할 수 있는 설명으로 바꾼다. */
export function diagnoseBluetoothError(error: unknown): BluetoothErrorDiagnosis {
  const { name, technical } = getNativeErrorDetails(error)
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
  private heartRateFns = new Set<(bpm: number, at: number) => void>()
  /** 로잉머신 자신이 노출한 심박 서비스(0x180D)의 측정 특성. 없으면 null */
  private hrChar: BluetoothRemoteGATTCharacteristic | null = null
  private statusFns = new Set<(s: SourceStatus, d?: string) => void>()
  private diagnosticFns = new Set<(entry: BleDiagnosticEntry) => void>()
  private packetCount = 0
  private firstPacketTimer: number | null = null
  private connecting = false
  private manualDisconnect = false
  private stage = 'idle'
  /** 한 번 연결에 성공한 뒤 사용자가 직접 끊기 전까지 true — 자동 재연결의 조건 */
  private wantConnected = false
  private reconnectTimer: number | null = null
  private reconnectAttempts = 0

  private onDisconnected = () => {
    this.clearFirstPacketTimer()
    this.log(
      this.manualDisconnect ? 'info' : 'error',
      this.manualDisconnect ? 'disconnect.manual' : 'disconnect.unexpected',
      this.manualDisconnect ? '사용자가 Bluetooth 연결을 종료했습니다.' : '로잉머신 연결이 예기치 않게 끊어졌습니다.',
      this.device?.name ?? undefined,
    )
    // 세션 도중에 끊긴 것이면 스스로 다시 붙는다.
    // 한 번 허용된 기기는 재연결에 사용자 제스처가 필요 없다 — 이게 자동 재연결이 가능한 이유다.
    if (this.wantConnected && !this.manualDisconnect && this.device) {
      this.setStatus('reconnecting', this.device.name ?? undefined)
      this.scheduleReconnect()
    } else {
      this.setStatus('disconnected')
    }
  }

  /** ⚠️ 반드시 사용자 클릭 핸들러 안에서 호출할 것. Web Bluetooth는 user gesture를 요구한다. */
  async connect(scanMode: BleScanMode = 'ftms'): Promise<void> {
    if (this.connecting || this.status === 'connected') {
      this.log('warning', 'connect.duplicate', '이미 연결 중이거나 연결되어 있어 중복 요청을 건너뜁니다.')
      return
    }
    this.connecting = true
    this.manualDisconnect = false
    this.packetCount = 0
    this.stage = 'preflight'
    this.log(
      'info', 'attempt.start',
      scanMode === 'all'
        ? 'Bluetooth 연결 시도를 시작합니다. 주변 기기를 모두 검색합니다.'
        : 'Bluetooth 연결 시도를 시작합니다. FTMS 로잉머신을 검색합니다.',
    )
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
    const policyDocument = (typeof document === 'undefined' ? undefined : document) as (Document & {
      permissionsPolicy?: { allowsFeature?: (feature: string) => boolean }
      featurePolicy?: { allowsFeature?: (feature: string) => boolean }
    }) | undefined
    try {
      const permissionsPolicy = policyDocument?.permissionsPolicy ?? policyDocument?.featurePolicy
      const bluetoothPolicyAllowed = permissionsPolicy?.allowsFeature?.('bluetooth')
      this.log(
        bluetoothPolicyAllowed === false ? 'error' : 'info',
        'preflight.policy',
        bluetoothPolicyAllowed === false
          ? '이 페이지의 Permissions Policy가 Bluetooth를 차단하고 있습니다.'
          : '페이지의 Bluetooth 정책 차단은 확인되지 않았습니다.',
        bluetoothPolicyAllowed === undefined ? '정책 API를 제공하지 않는 브라우저입니다.' : `bluetooth=${bluetoothPolicyAllowed}`,
      )
    } catch (error) {
      this.log(
        'warning', 'preflight.policy.unavailable',
        '브라우저의 Bluetooth 정책 상태는 읽지 못했지만 연결을 계속합니다.',
        formatNativeError(error),
      )
    }

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
      this.log(
        'info', `chooser.request.${scanMode}`,
        scanMode === 'all'
          ? '주변 Bluetooth 기기 선택창 표시를 요청했습니다. 목록에서 로잉머신을 선택하세요.'
          : 'FTMS 로잉머신 선택창 표시를 요청했습니다.',
      )
      const requestOptions: RequestDeviceOptions = scanMode === 'all'
        ? {
            acceptAllDevices: true,
            // 전체 검색에서는 선택 뒤 접근할 서비스를 반드시 optionalServices에 선언해야 한다.
            // 심박 서비스도 선언해 둔다 — 손잡이 센서나 짝지은 벨트의 심박을 FTMS가 아니라 따로 내보내는 로잉머신이 있다.
            optionalServices: [FTMS_SERVICE, HEART_RATE_SERVICE],
          }
        : {
            filters: [{ services: [FTMS_SERVICE] }],
            optionalServices: [HEART_RATE_SERVICE],
          }
      this.log(
        'info', 'chooser.invoke',
        'Bluefy의 requestDevice()를 지금 호출합니다.',
        `userActivation=${navigator.userActivation?.isActive ?? 'unknown'} | options=${JSON.stringify(requestOptions)}`,
      )
      const chooserWaitTimer = window.setTimeout(() => {
        this.log(
          'warning', 'chooser.waiting',
          '7초가 지나도 기기 선택이 완료되지 않았습니다.',
          '선택창이 보이지 않으면 Bluefy의 위치 권한도 확인하고 앱을 완전히 종료한 뒤 다시 여세요. Safari나 ChatGPT 내부 브라우저에서는 선택창이 뜨지 않습니다.',
        )
      }, 7_000)
      try {
        let pendingDevice: Promise<BluetoothDevice>
        try {
          pendingDevice = navigator.bluetooth.requestDevice(requestOptions)
          this.log(
            'success', 'chooser.promise.returned',
            'Bluefy가 requestDevice() 호출을 받았습니다. 기기 선택 응답을 기다립니다.',
          )
        } catch (error) {
          this.log(
            'error', 'chooser.throw.sync',
            'Bluefy가 기기 선택 요청을 받는 즉시 오류를 반환했습니다.',
            formatNativeError(error),
          )
          throw error
        }
        this.device = await pendingDevice
      } finally {
        window.clearTimeout(chooserWaitTimer)
      }
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
      await this.subscribeHeartRate(server)
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
      this.wantConnected = true
      this.reconnectAttempts = 0
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
    this.wantConnected = false
    this.cancelReconnect()
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
    this.hrChar?.removeEventListener('characteristicvaluechanged', this.handleHeartRate)
    this.hrChar = null
    this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected)
    this.device?.gatt?.disconnect()
    this.char = null
    this.device = null
    this.setStatus('disconnected')
    this.log('success', 'cleanup.done', 'Bluetooth 연결 정리를 마쳤습니다.')
  }

  // ── 자동 재연결 ──────────────────────────────────────────

  /** 재연결 시도 상한. 약 3분간 시도하고 포기한다. */
  private static readonly MAX_RECONNECT = 40

  private scheduleReconnect() {
    this.cancelReconnect()
    // 지수 백오프, 5초에서 상한. 세션 중이라 너무 느긋하면 곤란하다.
    const delay = Math.min(800 * 2 ** Math.min(this.reconnectAttempts, 3), 5_000)
    this.log(
      'info', 'reconnect.scheduled',
      `${(delay / 1000).toFixed(1)}초 뒤 재연결을 시도합니다. (${this.reconnectAttempts + 1}번째)`,
    )
    this.reconnectTimer = window.setTimeout(() => void this.tryReconnect(), delay)
  }

  private cancelReconnect() {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private async tryReconnect() {
    if (!this.wantConnected || !this.device?.gatt) return
    this.reconnectAttempts++

    try {
      const server = await this.device.gatt.connect()
      const service = await server.getPrimaryService(FTMS_SERVICE)
      const char = await service.getCharacteristic(CHAR.ROWER_DATA)
      // 이전 리스너가 남아 이중 수신되지 않게 정리하고 다시 건다
      this.char?.removeEventListener('characteristicvaluechanged', this.handleValue)
      this.char = char
      char.addEventListener('characteristicvaluechanged', this.handleValue)
      await char.startNotifications()
      await this.subscribeHeartRate(server)

      this.reconnectAttempts = 0
      this.setStatus('connected', this.device.name ?? undefined)
      this.log('success', 'reconnect.ok', '로잉머신에 다시 연결했습니다.')
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      if (this.reconnectAttempts >= FtmsSource.MAX_RECONNECT) {
        this.wantConnected = false
        this.log('error', 'reconnect.giveup', '재연결을 여러 번 시도했지만 실패했습니다.', detail)
        this.setStatus('error', '재연결에 실패했습니다. 로잉머신 전원과 블루투스를 확인하세요.')
        return
      }
      this.log('warning', 'reconnect.retry', '재연결에 실패해 다시 시도합니다.', detail)
      this.scheduleReconnect()
    }
  }

  onSample(fn: (s: RowerSample) => void) {
    this.sampleFns.add(fn)
    return () => this.sampleFns.delete(fn)
  }

  onStatus(fn: (s: SourceStatus, d?: string) => void) {
    this.statusFns.add(fn)
    return () => this.statusFns.delete(fn)
  }

  /** 로잉머신이 심박 서비스로 따로 보내는 심박. at은 샘플과 같은 performance.now() 기준 ms. */
  onHeartRate(fn: (bpm: number, at: number) => void) {
    this.heartRateFns.add(fn)
    return () => this.heartRateFns.delete(fn)
  }

  /**
   * 로잉머신 자신의 심박 서비스(0x180D)를 구독한다. 선택 항목이라 없거나 실패해도 연결은 계속한다.
   * Rower Data에 심박 비트를 안 켜는 기기도 손잡이 센서·짝지은 벨트 값을 이쪽으로는 보내는 경우가 있다.
   */
  private async subscribeHeartRate(server: BluetoothRemoteGATTServer) {
    this.hrChar?.removeEventListener('characteristicvaluechanged', this.handleHeartRate)
    this.hrChar = null
    try {
      const service = await server.getPrimaryService(HEART_RATE_SERVICE)
      const char = await service.getCharacteristic(HEART_RATE_MEASUREMENT)
      char.addEventListener('characteristicvaluechanged', this.handleHeartRate)
      await char.startNotifications()
      this.hrChar = char
      this.log('success', 'heart-rate.ok', '로잉머신의 심박 서비스(0x180D)를 구독했습니다.')
    } catch (error) {
      this.log(
        'info', 'heart-rate.none',
        '로잉머신에 별도 심박 서비스가 없습니다. 심박은 Rower Data 필드나 따로 연결한 심박 센서로 받습니다.',
        formatNativeError(error),
      )
    }
  }

  private handleHeartRate = (ev: Event) => {
    const view = (ev.target as BluetoothRemoteGATTCharacteristic).value
    if (!view) return
    const bpm = parseHeartRateMeasurement(view)
    if (bpm === null) return
    const at = performance.now()
    for (const fn of this.heartRateFns) fn(bpm, at)
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
    if (this.packetCount === 1) this.clearFirstPacketTimer()
    // 처음 몇 패킷과 그 뒤 주기적으로 값까지 남긴다 — "페이스·심박이 안 나온다"는 보고는 기기가 그 필드를
    // 어떤 값으로 보내는지(0인지, 단위가 다른지, 분할 알림의 어느 쪽에 실리는지) 봐야만 풀린다.
    // 분할 알림은 두 패킷이 번갈아 오므로 첫 셋을 다 남긴다. 120패킷(2Hz면 1분)마다 하나는 운동 중 값이다.
    if (this.packetCount <= 3 || this.packetCount % PACKET_SAMPLE_EVERY === 0) {
      this.log(
        this.packetCount === 1 ? 'success' : 'info',
        this.packetCount === 1 ? 'packet.first' : 'packet.sample',
        this.packetCount === 1
          ? `첫 로잉 데이터를 받았습니다 (${view.byteLength} bytes).`
          : `로잉 데이터 #${this.packetCount} (${view.byteLength} bytes)`,
        `flags=${flags} ${describeRowerData(data)} | raw=${hexdump(view)}`,
      )
    }
    if (data.truncated) {
      // 반복되는 잘린 패킷이 로그를 가득 채우지 않게 첫 번과 이후 20개마다 남긴다.
      if (this.packetCount === 1 || this.packetCount % 20 === 0) {
        this.log(
          'warning', 'packet.truncated',
          '패킷 길이가 FTMS flags가 표시한 데이터보다 짧습니다. 잘린 뒤의 필드(심박 등)는 읽지 못합니다.',
          `received=${view.byteLength} bytes, flags=${flags} ${describeRowerData(data)} | raw=${hexdump(view)}`,
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
    this.hrChar?.removeEventListener('characteristicvaluechanged', this.handleHeartRate)
    this.hrChar = null
    this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected)
    this.device?.gatt?.disconnect()
    this.char = null
    this.device = null
    this.log('info', 'cleanup.failure', '실패한 연결의 부분 상태를 정리했습니다.')
  }
}
