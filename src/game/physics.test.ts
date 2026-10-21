import { describe, it, expect } from 'vitest'
import { BoatTracker, powerToSpeed, speedToSplit, splitToPower } from './physics'

describe('Concept2 파워 ↔ 페이스', () => {
  it('파워와 스플릿이 서로 역변환된다', () => {
    for (const split of [90, 120, 145, 180]) {
      expect(speedToSplit(powerToSpeed(splitToPower(split)))).toBeCloseTo(split, 6)
    }
  })

  it('2:00 스플릿은 대략 203W', () => {
    expect(splitToPower(120)).toBeCloseTo(202.6, 0)
  })

  it('파워가 8배면 속도는 2배 (세제곱 관계)', () => {
    expect(powerToSpeed(800) / powerToSpeed(100)).toBeCloseTo(2, 6)
  })
})

describe('BoatTracker', () => {
  it('기기의 누적 거리가 0이 아니어도 세션은 0에서 시작한다', () => {
    // 로잉머신은 전원 켠 뒤로 totalDistance를 계속 쌓는다.
    // 그대로 쓰면 레이스 시작하자마자 거리가 그 값으로 점프한다.
    const b = new BoatTracker()
    b.onSample(4200, 4.0)          // 이전 세션에서 이미 4.2km를 탄 기기
    b.update(0.1)
    expect(b.distance).toBeLessThan(1)
  })

  it('실기기처럼 2Hz로 들어와도 기기 거리를 그대로 따라간다', () => {
    // 예전 구현은 외삽분을 빼고 보정해서 4m/s에서 항상 6m쯤 앞서 있었다.
    // 로잉머신 모니터와 화면 숫자가 계속 어긋나 보이는 문제.
    const b = new BoatTracker()
    const SPEED = 4.0
    let deviceDist = 4200          // 기기는 이미 4.2km를 쌓아둔 상태
    let sinceSample = 0

    b.onSample(deviceDist, SPEED)
    for (let frame = 0; frame < 60 * 30; frame++) {   // 60fps × 30초
      const dt = 1 / 60
      deviceDist += SPEED * dt
      sinceSample += dt
      if (sinceSample >= 0.5) {                       // 실기기와 같은 2Hz
        sinceSample = 0
        b.onSample(Math.floor(deviceDist), SPEED)     // 기기는 정수 미터로 준다
      }
      b.update(dt)
    }

    const expected = deviceDist - 4200               // 세션 시작 이후 실제 이동거리
    // 남는 오차는 기기가 정수 미터로만 보고하는 데서 오는 것(평균 0.5m)이고,
    // 시간이 지나도 누적되지 않는다. 예전 구현은 여기서 6m씩 앞서 있었다.
    expect(Math.abs(b.distance - expected)).toBeLessThan(1.5)
  })

  it('정수 반올림이 없으면 기기 거리와 사실상 일치한다', () => {
    const b = new BoatTracker()
    const SPEED = 4.0
    let deviceDist = 0
    let sinceSample = 0
    b.onSample(0, SPEED)
    for (let frame = 0; frame < 60 * 30; frame++) {
      const dt = 1 / 60
      deviceDist += SPEED * dt
      sinceSample += dt
      if (sinceSample >= 0.5) { sinceSample = 0; b.onSample(deviceDist, SPEED) }
      b.update(dt)
    }
    expect(Math.abs(b.distance - deviceDist)).toBeLessThan(0.2)
  })

  it('시작 이후의 증가분만 누적한다', () => {
    const b = new BoatTracker()
    b.onSample(4200, 4.0)
    b.onSample(4300, 4.0)          // 기기 기준 100m 전진
    b.update(1 / 60)
    expect(b.distance).toBeGreaterThan(95)
    expect(b.distance).toBeLessThan(105)
  })

  it('reset하면 기준점도 다시 잡는다', () => {
    const b = new BoatTracker()
    b.onSample(4200, 4.0); b.update(0.1)
    b.reset()
    b.onSample(9000, 4.0); b.update(0.1)
    expect(b.distance).toBeLessThan(1)
  })

  it('기기가 거리를 안 주면 속도를 적분한다', () => {
    const b = new BoatTracker()
    b.onSample(null, 4.0)
    for (let i = 0; i < 400; i++) b.update(0.05)   // 20초
    // 관성 때문에 초반이 느리므로 80m보다 조금 적게 나온다
    expect(b.distance).toBeGreaterThan(70)
    expect(b.distance).toBeLessThan(80)
    expect(b.speed).toBeCloseTo(4.0, 2)
  })

  it('기기 거리와 크게 벌어지면 즉시 맞춘다', () => {
    const b = new BoatTracker()
    b.onSample(0, 4.0)
    b.onSample(500, 4.0)           // 갑자기 500m 점프 (재연결 등)
    b.update(0.1)
    expect(b.distance).toBeCloseTo(500, 0)
  })

  /** 프레임마다 화면 속도(거리 변화 / dt)를 재서 워밍업 뒤의 최소·최대를 돌려준다 */
  function frameSpeeds(
    seconds: number, warmup: number,
    step: (t: number, b: BoatTracker) => void,
  ) {
    const b = new BoatTracker()
    const dt = 1 / 60
    let min = Infinity, max = 0, sum = 0, n = 0
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      const t = i * dt
      step(t, b)
      const before = b.distance
      b.update(dt)
      const v = (b.distance - before) / dt
      if (t >= warmup) { min = Math.min(min, v); max = Math.max(max, v); sum += v; n++ }
    }
    return { min, max, mean: sum / n }
  }

  it('스트로크마다 한 번만 거리를 올리는 콘솔에서도 리커버리 때 배가 서지 않는다', () => {
    // 22spm(2.73초)마다 거리가 9m씩 뛰고, 그 사이 패킷은 같은 거리와 붙든 속도(3.3 m/s)를 0.5초마다 보낸다.
    // 예전엔 패킷마다 외삽 기준을 새로 잡아 목표 지점이 제자리에 묶였고, 배가 리커버리마다 끌려 섰다.
    const period = 2.73
    let nextPacket = 0
    const r = frameSpeeds(30, 12, (t, b) => {
      if (t < nextPacket) return
      nextPacket += 0.5
      b.onSample(1000 + Math.floor(t / period) * 9, 9 / period)
    })
    expect(r.min).toBeGreaterThan(r.mean * 0.6)
    expect(r.max).toBeLessThan(r.mean * 1.6)
  })

  it('순간 속도가 드라이브·리커버리로 크게 출렁여도 화면 속도는 물 흐르듯 이어진다', () => {
    // 드라이브 1초 4.6 m/s, 리커버리 1.5초 2.6 m/s — 플라이휠 속도를 그대로 보내는 콘솔. 평균 3.4 m/s.
    let nextPacket = 0
    let dist = 0
    let lastT = 0
    const speedAt = (t: number) => (t % 2.5 < 1 ? 4.6 : 2.6)
    const r = frameSpeeds(30, 12, (t, b) => {
      dist += speedAt(t) * (t - lastT)
      lastT = t
      if (t < nextPacket) return
      nextPacket += 0.5
      b.onSample(Math.floor(dist), speedAt(t))
    })
    expect(r.mean).toBeCloseTo(3.4, 0)
    // 실제 배의 스트로크 출렁임 정도(±20%)는 남기되, 멈칫하지는 않는다
    expect(r.min).toBeGreaterThan(r.mean * 0.75)
    expect(r.max).toBeLessThan(r.mean * 1.3)
  })

  it('앞서 나간 만큼 기다려 맞추되 뒤로 가지는 않는다', () => {
    const b = new BoatTracker()
    b.onSample(0, 4.0)
    for (let i = 0; i < 120; i++) b.update(1 / 60)
    b.onSample(0, 0)             // 기기는 거리 그대로, 속도 0 — 화면이 앞서 있다
    let prev = b.distance
    for (let i = 0; i < 600; i++) {
      b.update(1 / 60)
      expect(b.distance).toBeGreaterThanOrEqual(prev)
      prev = b.distance
    }
  })
})
