import { FLAG } from './ftms'
import type { RowerData } from '../types'

/**
 * FTMS Rower Data(0x2AD1) 파서.
 *
 * 페이로드는 [uint16 flags][가변 필드들] 구조이고, 필드는 **고정된 순서**로
 * flags가 켜진 것만 실려온다. 따라서 오프셋을 하드코딩하면 안 되고
 * flags를 훑으면서 누적 계산해야 한다.
 *
 * 모든 멀티바이트 값은 little-endian.
 */
export function parseRowerData(view: DataView): RowerData {
  const out: RowerData = {}
  if (view.byteLength < 2) return { truncated: true }

  const flags = view.getUint16(0, true)
  let o = 2

  const has = (bit: number) => (flags & (1 << bit)) !== 0
  /** 남은 바이트가 부족하면 파싱 중단. 스펙과 다르게 보내는 기기가 실제로 있다. */
  const room = (n: number) => o + n <= view.byteLength

  // ⚠️ bit 0은 반전: 0일 때 존재
  if (!has(FLAG.MORE_DATA)) {
    if (!room(3)) return { ...out, truncated: true }
    out.strokeRate = view.getUint8(o) * 0.5   // resolution 0.5 /min
    o += 1
    out.strokeCount = view.getUint16(o, true)
    o += 2
  }

  if (has(FLAG.AVG_STROKE_RATE)) {
    if (!room(1)) return { ...out, truncated: true }
    out.avgStrokeRate = view.getUint8(o) * 0.5
    o += 1
  }

  if (has(FLAG.TOTAL_DISTANCE)) {
    if (!room(3)) return { ...out, truncated: true }
    out.totalDistance = getUint24LE(view, o)   // uint24, meters
    o += 3
  }

  if (has(FLAG.INST_PACE)) {
    if (!room(2)) return { ...out, truncated: true }
    out.instantaneousPace = view.getUint16(o, true)  // s per 500m
    o += 2
  }

  if (has(FLAG.AVG_PACE)) {
    if (!room(2)) return { ...out, truncated: true }
    out.averagePace = view.getUint16(o, true)
    o += 2
  }

  if (has(FLAG.INST_POWER)) {
    if (!room(2)) return { ...out, truncated: true }
    out.instantaneousPower = view.getInt16(o, true)  // sint16, watts
    o += 2
  }

  if (has(FLAG.AVG_POWER)) {
    if (!room(2)) return { ...out, truncated: true }
    out.averagePower = view.getInt16(o, true)
    o += 2
  }

  if (has(FLAG.RESISTANCE_LEVEL)) {
    if (!room(2)) return { ...out, truncated: true }
    out.resistanceLevel = view.getInt16(o, true)
    o += 2
  }

  // 한 비트에 필드 3개가 딸려온다
  if (has(FLAG.EXPENDED_ENERGY)) {
    if (!room(5)) return { ...out, truncated: true }
    out.totalEnergy = view.getUint16(o, true)      // kcal
    o += 2
    out.energyPerHour = view.getUint16(o, true)    // kcal/h
    o += 2
    out.energyPerMinute = view.getUint8(o)         // kcal/min
    o += 1
  }

  if (has(FLAG.HEART_RATE)) {
    if (!room(1)) return { ...out, truncated: true }
    out.heartRate = view.getUint8(o)
    o += 1
  }

  if (has(FLAG.METABOLIC_EQUIVALENT)) {
    if (!room(1)) return { ...out, truncated: true }
    out.metabolicEquivalent = view.getUint8(o) * 0.1
    o += 1
  }

  if (has(FLAG.ELAPSED_TIME)) {
    if (!room(2)) return { ...out, truncated: true }
    out.elapsedTime = view.getUint16(o, true)      // s
    o += 2
  }

  if (has(FLAG.REMAINING_TIME)) {
    if (!room(2)) return { ...out, truncated: true }
    out.remainingTime = view.getUint16(o, true)    // s
    o += 2
  }

  return out
}

function getUint24LE(v: DataView, o: number): number {
  return v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16)
}

/** 실기기 검증용. 콘솔에 원본 바이트를 찍어 스펙과 대조할 때 쓴다. */
export function hexdump(view: DataView): string {
  const b: string[] = []
  for (let i = 0; i < view.byteLength; i++) {
    b.push(view.getUint8(i).toString(16).padStart(2, '0'))
  }
  return b.join(' ')
}
