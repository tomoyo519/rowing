/** Fitness Machine Service. 16비트 UUID는 Web Bluetooth가 숫자로 받아준다. */
export const FTMS_SERVICE = 0x1826

export const CHAR = {
  /** Rower Data — notify. 로잉 데이터의 본체. */
  ROWER_DATA: 0x2ad1,
  /** Fitness Machine Feature — read. 이 기기가 어떤 필드를 지원하는지. */
  FEATURE: 0x2acc,
  /** Fitness Machine Status — notify. 시작/정지/일시정지 등 상태 변화. */
  STATUS: 0x2ada,
  /** Fitness Machine Control Point — write/indicate. 저항 제어 등. 지금은 미사용. */
  CONTROL_POINT: 0x2ad9,
} as const

/** 심박 벨트를 따로 붙일 경우를 대비해 optionalServices에 실어둔다. */
export const HEART_RATE_SERVICE = 0x180d

/**
 * Rower Data flags 비트 정의.
 *
 * ⚠️ bit 0(MORE_DATA)만 의미가 반대다.
 *    다른 비트는 "1이면 필드 있음"인데, bit 0은 "0이면 Stroke Rate/Count 있음".
 *    FTMS 파서 버그의 90%가 여기서 나온다.
 */
export const FLAG = {
  MORE_DATA: 0,          // 반전! 0 = strokeRate + strokeCount 존재
  AVG_STROKE_RATE: 1,
  TOTAL_DISTANCE: 2,
  INST_PACE: 3,
  AVG_PACE: 4,
  INST_POWER: 5,
  AVG_POWER: 6,
  RESISTANCE_LEVEL: 7,
  EXPENDED_ENERGY: 8,    // totalEnergy + energyPerHour + energyPerMinute 3개 묶음
  HEART_RATE: 9,
  METABOLIC_EQUIVALENT: 10,
  ELAPSED_TIME: 11,
  REMAINING_TIME: 12,
} as const
