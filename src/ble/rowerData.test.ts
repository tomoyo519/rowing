import { describe, it, expect } from 'vitest'
import { parseRowerData } from './rowerData'

const build = (bytes: number[]) => new DataView(new Uint8Array(bytes).buffer)

describe('parseRowerData', () => {
  it('일반적인 필드 조합을 파싱한다', () => {
    // flags = bit2(거리) | bit3(페이스) | bit5(파워) | bit11(경과시간), bit0=0 → 스트로크 존재
    const d = parseRowerData(build([
      0x2c, 0x08,        // flags 0x082C
      52,                // strokeRate 52 * 0.5 = 26 spm
      0x64, 0x00,        // strokeCount 100
      0xd2, 0x04, 0x00,  // totalDistance 1234 (uint24 LE)
      0x82, 0x00,        // instPace 130 s
      0xc8, 0x00,        // instPower 200 W
      0x2c, 0x01,        // elapsedTime 300 s
    ]))
    expect(d).toMatchObject({
      strokeRate: 26, strokeCount: 100, totalDistance: 1234,
      instantaneousPace: 130, instantaneousPower: 200, elapsedTime: 300,
    })
    expect(d.truncated).toBeUndefined()
  })

  it('bit0은 반전이다 — 1이면 스트로크 필드가 없고 오프셋이 밀리면 안 된다', () => {
    const d = parseRowerData(build([
      0x05, 0x00,        // flags = bit0 | bit2
      0xe8, 0x03, 0x00,  // totalDistance 1000
    ]))
    expect(d.strokeRate).toBeUndefined()
    expect(d.strokeCount).toBeUndefined()
    expect(d.totalDistance).toBe(1000)  // 스트로크 3바이트를 안 건너뛰었다면 여기서 깨진다
  })

  it('EXPENDED_ENERGY 비트 하나에 필드 3개가 딸려온다', () => {
    const d = parseRowerData(build([
      0x01, 0x03,        // flags = bit0 | bit8 | bit9
      0x2a, 0x00,        // totalEnergy 42
      0x90, 0x01,        // energyPerHour 400
      0x07,              // energyPerMinute 7
      0x8c,              // heartRate 140
    ]))
    expect(d).toMatchObject({
      totalEnergy: 42, energyPerHour: 400, energyPerMinute: 7, heartRate: 140,
    })
  })

  it('페이로드가 flags보다 짧으면 던지지 않고 truncated로 표시한다', () => {
    const d = parseRowerData(build([0x2c, 0x08, 52, 0x64, 0x00, 0xd2]))
    expect(d.strokeRate).toBe(26)       // 여기까지는 살린다
    expect(d.totalDistance).toBeUndefined()
    expect(d.truncated).toBe(true)
  })

  it('파워는 sint16이라 음수가 나올 수 있다', () => {
    const d = parseRowerData(build([0x21, 0x00, 0xf6, 0xff]))
    expect(d.instantaneousPower).toBe(-10)
  })

  it('빈 페이로드에도 던지지 않는다', () => {
    expect(parseRowerData(build([])).truncated).toBe(true)
  })
})
