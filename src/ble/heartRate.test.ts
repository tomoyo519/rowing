import { describe, it, expect } from 'vitest'
import { parseHeartRateMeasurement } from './heartRate'

const build = (bytes: number[]) => new DataView(new Uint8Array(bytes).buffer)

describe('parseHeartRateMeasurement', () => {
  it('flags bit0=0이면 uint8 심박이다', () => {
    expect(parseHeartRateMeasurement(build([0x00, 0x8c]))).toBe(140)
  })

  it('flags bit0=1이면 uint16 심박이다', () => {
    expect(parseHeartRateMeasurement(build([0x01, 0xb4, 0x00]))).toBe(180)
    expect(parseHeartRateMeasurement(build([0x01, 0x2c, 0x01]))).toBeNull()  // 300bpm — 사람 심박이 아니다
  })

  it('뒤에 붙는 에너지·RR 간격은 무시한다', () => {
    // flags: RR 간격 있음(bit4) + 에너지 있음(bit3)
    expect(parseHeartRateMeasurement(build([0x18, 0x5a, 0x10, 0x00, 0x3c, 0x03]))).toBe(90)
  })

  it('0(아직 못 잼)과 빈 페이로드는 null이다', () => {
    expect(parseHeartRateMeasurement(build([0x00, 0x00]))).toBeNull()
    expect(parseHeartRateMeasurement(build([0x00]))).toBeNull()
    expect(parseHeartRateMeasurement(build([]))).toBeNull()
    expect(parseHeartRateMeasurement(build([0x01, 0x8c]))).toBeNull()  // uint16이라 했는데 1바이트만
  })
})
