import { afterEach, describe, expect, it, vi } from 'vitest'
import { diagnoseBluetoothError, FtmsSource } from './connection'
import { CHAR, FTMS_SERVICE } from './ftms'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function stubBrowser(requestDevice: (options?: RequestDeviceOptions) => Promise<BluetoothDevice>) {
  vi.stubGlobal('navigator', {
    bluetooth: { requestDevice },
    userAgent: 'makeRowing BLE test browser',
    userActivation: { isActive: true },
  })
  vi.stubGlobal('location', { origin: 'https://rowing.test' })
  vi.stubGlobal('window', {
    isSecureContext: true,
    setTimeout: (fn: TimerHandler, ms?: number) => globalThis.setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => globalThis.clearTimeout(
      id as unknown as ReturnType<typeof globalThis.setTimeout>,
    ),
  })
}

function successfulDevice(featureFails = false) {
  const rower = new EventTarget() as BluetoothRemoteGATTCharacteristic
  Object.assign(rower, {
    startNotifications: vi.fn(async () => rower),
    stopNotifications: vi.fn(async () => rower),
  })
  const feature = {
    readValue: vi.fn(async () => new DataView(new Uint8Array([1, 2, 3, 4]).buffer)),
  }
  const service = {
    getCharacteristic: vi.fn(async (uuid: BluetoothCharacteristicUUID) => {
      if (uuid === CHAR.FEATURE) {
        if (featureFails) throw new DOMException('feature unavailable', 'NotSupportedError')
        return feature as unknown as BluetoothRemoteGATTCharacteristic
      }
      return rower
    }),
  }
  const server = {
    getPrimaryService: vi.fn(async () => service as unknown as BluetoothRemoteGATTService),
  }
  const target = new EventTarget()
  const device = target as BluetoothDevice
  Object.assign(device, {
    name: 'Test Rower',
    gatt: {
      connected: false,
      connect: vi.fn(async () => server as unknown as BluetoothRemoteGATTServer),
      disconnect: vi.fn(),
    },
  })
  return { device, rower }
}

describe('Bluetooth 오류 진단', () => {
  it.each([
    ['NotFoundError', '선택'],
    ['SecurityError', '보안'],
    ['NotAllowedError', '권한'],
    ['NetworkError', '통신'],
    ['InvalidStateError', '상태'],
    ['NotSupportedError', '지원'],
  ])('%s 이름을 행동 가능한 설명으로 보존한다', (name, word) => {
    const diagnosis = diagnoseBluetoothError(new DOMException('technical detail', name))
    expect(diagnosis.name).toBe(name)
    expect(diagnosis.summary).toContain(word)
    expect(diagnosis.suggestion.length).toBeGreaterThan(10)
    expect(diagnosis.technical).toBe('technical detail')
  })

  it('알 수 없는 값도 기술 정보를 잃지 않는다', () => {
    const diagnosis = diagnoseBluetoothError('vendor failure 42')
    expect(diagnosis.name).toBe('UnknownError')
    expect(diagnosis.technical).toContain('42')
  })

  it('Bluefy 네이티브 브리지의 일반 객체 오류도 이름·코드·원문을 보존한다', () => {
    const diagnosis = diagnoseBluetoothError({
      name: 'NotAllowedError',
      message: 'native bridge denied',
      code: 2,
    })
    expect(diagnosis.name).toBe('NotAllowedError')
    expect(diagnosis.technical).toContain('native bridge denied')
    expect(diagnosis.technical).toContain('code=2')
    expect(diagnosis.technical).toContain('raw=')
  })

  it('성공 연결의 chooser부터 notifications까지 단계 코드를 순서대로 남긴다', async () => {
    const { device } = successfulDevice()
    const requestDevice = vi.fn(async () => device)
    stubBrowser(requestDevice)
    const source = new FtmsSource()
    const codes: string[] = []
    source.onDiagnostic(entry => codes.push(entry.code))

    await source.connect()
    expect(codes).toEqual([
      'attempt.start', 'preflight.bluetooth', 'preflight.secure', 'preflight.policy',
      'chooser.request.ftms', 'chooser.invoke', 'chooser.promise.returned', 'chooser.selected',
      'gatt.connect.start', 'gatt.connect.ok',
      'service.ftms.start', 'service.ftms.ok',
      'feature.read.start', 'feature.read.ok',
      'rower-char.start', 'rower-char.ok',
      'notifications.start', 'notifications.ok', 'connected',
    ])
    expect(requestDevice).toHaveBeenCalledWith({
      filters: [{ services: [FTMS_SERVICE] }],
    })
    expect(source.status).toBe('connected')
    await source.disconnect()
  })

  it('전체 검색은 선택창에 모든 BLE 기기를 요청하고 FTMS 접근 권한을 남긴다', async () => {
    const { device } = successfulDevice()
    const requestDevice = vi.fn(async () => device)
    stubBrowser(requestDevice)
    const source = new FtmsSource()
    const codes: string[] = []
    source.onDiagnostic(entry => codes.push(entry.code))

    await source.connect('all')

    expect(requestDevice).toHaveBeenCalledWith({
      acceptAllDevices: true,
      optionalServices: [FTMS_SERVICE],
    })
    expect(codes).toContain('chooser.request.all')
    await source.disconnect()
  })

  it('선택창 응답이 늦으면 Bluefy 권한과 새로고침 안내를 로그에 남긴다', async () => {
    vi.useFakeTimers()
    const { device } = successfulDevice()
    let finishSelection!: (device: BluetoothDevice) => void
    stubBrowser(() => new Promise(resolve => { finishSelection = resolve }))
    const source = new FtmsSource()
    const messages: { code: string; detail?: string }[] = []
    source.onDiagnostic(entry => messages.push({ code: entry.code, detail: entry.detail }))

    const connecting = source.connect('all')
    await vi.advanceTimersByTimeAsync(7_000)

    expect(messages).toContainEqual(expect.objectContaining({
      code: 'chooser.waiting',
      detail: expect.stringContaining('Bluefy'),
    }))
    finishSelection(device)
    await connecting
    await source.disconnect()
  })

  it('선택 기능 읽기 실패는 경고로 남기고 실제 데이터 연결은 계속한다', async () => {
    const { device } = successfulDevice(true)
    stubBrowser(async () => device)
    const source = new FtmsSource()
    const entries: { code: string; level: string }[] = []
    source.onDiagnostic(entry => entries.push({ code: entry.code, level: entry.level }))

    await source.connect()
    expect(entries).toContainEqual({ code: 'feature.read.skipped', level: 'warning' })
    expect(entries.at(-1)).toEqual({ code: 'connected', level: 'success' })
    await source.disconnect()
  })

  it('기기 선택 취소는 chooser 단계와 원래 DOMException 이름을 보존한다', async () => {
    stubBrowser(async () => { throw new DOMException('User cancelled chooser', 'NotFoundError') })
    const source = new FtmsSource()
    const errors: { message: string; errorName?: string }[] = []
    source.onDiagnostic(entry => {
      if (entry.level === 'error') errors.push({ message: entry.message, errorName: entry.errorName })
    })

    await expect(source.connect()).rejects.toMatchObject({ name: 'NotFoundError' })
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain('chooser 단계')
    expect(errors[0]!.errorName).toBe('NotFoundError')
  })

  it('첫 실제 Rower Data 패킷을 별도 성공 단계로 한 번만 기록한다', async () => {
    const { device, rower } = successfulDevice()
    const value = new DataView(new Uint8Array([0, 0, 52, 1, 0]).buffer)
    Object.defineProperty(rower, 'value', { configurable: true, get: () => value })
    stubBrowser(async () => device)
    const source = new FtmsSource()
    const codes: string[] = []
    const samples: number[] = []
    source.onDiagnostic(entry => codes.push(entry.code))
    source.onSample(sample => samples.push(sample.strokeRate ?? 0))

    await source.connect()
    rower.dispatchEvent(new Event('characteristicvaluechanged'))
    rower.dispatchEvent(new Event('characteristicvaluechanged'))

    expect(codes.filter(code => code === 'packet.first')).toHaveLength(1)
    expect(samples).toEqual([26, 26])
    await source.disconnect()
  })

  it('성공 뒤 예기치 않게 끊기면 선택창 없이 기존 기기에 자동 재연결한다', async () => {
    vi.useFakeTimers()
    const { device } = successfulDevice()
    const requestDevice = vi.fn(async () => device)
    stubBrowser(requestDevice)
    const source = new FtmsSource()
    const statuses: string[] = []
    const codes: string[] = []
    source.onStatus(status => statuses.push(status))
    source.onDiagnostic(entry => codes.push(entry.code))

    await source.connect()
    device.dispatchEvent(new Event('gattserverdisconnected'))

    expect(statuses.at(-1)).toBe('reconnecting')
    expect(codes).toContain('reconnect.scheduled')
    await vi.advanceTimersByTimeAsync(800)

    expect(statuses.at(-1)).toBe('connected')
    expect(codes).toContain('reconnect.ok')
    expect(requestDevice).toHaveBeenCalledTimes(1)
    expect(device.gatt!.connect).toHaveBeenCalledTimes(2)
    await source.disconnect()
  })
})
