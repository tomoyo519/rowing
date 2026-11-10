import { describe, it, expect, beforeEach } from 'vitest'
import {
  HULLS, BLADES, COIN_RULES, WALLET_KEY, emptyWallet, loadWallet, saveWallet, buySkin, selectSkin, isUnlocked,
  skinKey, playerRigColors, addCoins, touchDay, previousDay, CoinLedger, type WalletState,
} from './wallet'
import { COMBO_MILESTONES } from './combo'
import { COLORS_PLAYER } from '../three/rig'

// node 환경엔 localStorage가 없다 — 최소 구현으로 대체
beforeEach(() => {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage
})

const wallet = (over: Partial<WalletState> = {}): WalletState => ({ ...emptyWallet(), ...over })

describe('스킨 목록과 코인 규칙', () => {
  it('첫 선체·노는 무료 기본이고 rig.ts의 플레이어 색과 같다', () => {
    expect(HULLS[0]).toMatchObject({ id: 'navy', cost: 0, hull: COLORS_PLAYER.hull, trim: COLORS_PLAYER.trim })
    expect(BLADES[0]).toMatchObject({ id: 'white', cost: 0, blade: COLORS_PLAYER.blade, oar: COLORS_PLAYER.oar })
    expect(HULLS.slice(1).every(h => h.cost > 0)).toBe(true)
    expect(BLADES.slice(1).every(b => b.cost > 0)).toBe(true)
  })

  it('id는 종류 안에서 겹치지 않는다', () => {
    expect(new Set(HULLS.map(h => h.id)).size).toBe(HULLS.length)
    expect(new Set(BLADES.map(b => b.id)).size).toBe(BLADES.length)
  })

  it('콤보 코인 표는 콤보 단계와 같은 지점에 있고, 100m당 1코인, 출석 보너스는 10/일·최대 50', () => {
    expect(Object.keys(COIN_RULES.combo).map(Number).sort((a, b) => a - b)).toEqual([...COMBO_MILESTONES])
    expect(COIN_RULES.perMeter * 100).toBeCloseTo(1, 12)
    expect(COIN_RULES.streakPerDay).toBe(10)
    expect(COIN_RULES.streakMax).toBe(50)
  })
})

describe('빈 지갑과 저장/불러오기', () => {
  it('emptyWallet은 코인 0, 기본 스킨만 해금, 출석 없음', () => {
    expect(emptyWallet()).toEqual({
      coins: 0, earned: 0, unlocked: ['hull:navy', 'blade:white'], hull: 'navy', blade: 'white', lastDay: null, streak: 0,
    })
    // 매번 새 객체
    expect(emptyWallet()).not.toBe(emptyWallet())
  })

  it('저장한 지갑을 그대로 읽는다', () => {
    const w = wallet({
      coins: 130, earned: 400, unlocked: ['hull:navy', 'blade:white', 'hull:coral'], hull: 'coral', lastDay: '2026-11-10', streak: 3,
    })
    saveWallet(w)
    expect(localStorage.getItem(WALLET_KEY)).not.toBeNull()
    expect(loadWallet()).toEqual(w)
  })

  it('저장된 게 없으면 빈 지갑', () => {
    expect(loadWallet()).toEqual(emptyWallet())
  })

  it('손상된 JSON이어도 던지지 않고 빈 지갑', () => {
    localStorage.setItem(WALLET_KEY, '{{{ not json')
    expect(loadWallet()).toEqual(emptyWallet())
  })

  it('이상한 값은 걸러낸다 — 소수 코인은 내림, 음수는 0, 모르는 스킨은 기본으로, 기본 스킨은 항상 해금', () => {
    localStorage.setItem(WALLET_KEY, JSON.stringify({
      coins: 12.7, earned: -3, unlocked: ['hull:coral', 5, 'hull:coral'], hull: 'coral', blade: 'nope', streak: -2, lastDay: 42,
    }))
    const w = loadWallet()
    expect(w.coins).toBe(12)
    expect(w.earned).toBe(0)
    expect(w.unlocked).toEqual(['hull:navy', 'blade:white', 'hull:coral'])
    expect(w.hull).toBe('coral')
    expect(w.blade).toBe('white')
    expect(w.streak).toBe(0)
    expect(w.lastDay).toBeNull()
  })

  it('localStorage가 없어도 던지지 않는다', () => {
    delete (globalThis as { localStorage?: Storage }).localStorage
    expect(() => saveWallet(emptyWallet())).not.toThrow()
    expect(loadWallet()).toEqual(emptyWallet())
  })
})

describe('구매와 선택', () => {
  it('코인이 모자라면 null — 지갑은 그대로', () => {
    const coral = HULLS.find(h => h.id === 'coral')!
    const w = wallet({ coins: coral.cost - 1 })
    expect(buySkin(w, 'hull', 'coral')).toBeNull()
    expect(w.coins).toBe(coral.cost - 1)
    expect(isUnlocked(w, 'hull', 'coral')).toBe(false)
  })

  it('살 수 있으면 값을 빼고 해금한 뒤 바로 선택한다 — 원본은 바꾸지 않는다', () => {
    const coral = HULLS.find(h => h.id === 'coral')!
    const w = wallet({ coins: 200, earned: 200 })
    const next = buySkin(w, 'hull', 'coral')!
    expect(next.coins).toBe(200 - coral.cost)
    expect(next.earned).toBe(200)   // 번 총액은 그대로
    expect(next.unlocked).toContain(skinKey('hull', 'coral'))
    expect(next.hull).toBe('coral')
    expect(w.coins).toBe(200)
    expect(w.hull).toBe('navy')
    expect(w.unlocked).toHaveLength(2)
  })

  it('딱 맞는 코인이면 살 수 있다', () => {
    const red = BLADES.find(b => b.id === 'red')!
    expect(buySkin(wallet({ coins: red.cost }), 'blade', 'red')).toMatchObject({ coins: 0, blade: 'red' })
  })

  it('이미 가진 스킨을 다시 사면 코인은 그대로고 선택만 바뀐다', () => {
    const w = wallet({ coins: 10, unlocked: ['hull:navy', 'blade:white', 'blade:teal'] })
    const next = buySkin(w, 'blade', 'teal')!
    expect(next.coins).toBe(10)
    expect(next.blade).toBe('teal')
    expect(next.unlocked).toEqual(w.unlocked)
  })

  it('모르는 스킨은 null', () => {
    expect(buySkin(wallet({ coins: 9999 }), 'hull', 'nope')).toBeNull()
    expect(buySkin(wallet({ coins: 9999 }), 'blade', 'navy')).toBeNull()   // 선체 id를 노에 쓰면 없다
  })

  it('selectSkin은 잠긴 스킨을 무시하고 같은 지갑을 돌려준다', () => {
    const w = wallet()
    expect(selectSkin(w, 'hull', 'gold')).toBe(w)
    expect(selectSkin(w, 'blade', 'gold')).toBe(w)
    const owned = wallet({ unlocked: ['hull:navy', 'blade:white', 'hull:gold'] })
    expect(selectSkin(owned, 'hull', 'gold').hull).toBe('gold')
    expect(selectSkin(owned, 'hull', 'gold').blade).toBe('white')
    expect(selectSkin(owned, 'blade', 'white').blade).toBe('white')
  })
})

describe('playerRigColors', () => {
  it('선택한 선체(hull·trim)와 노(blade·oar)만 덮고 나머지 색은 base 그대로', () => {
    const colors = playerRigColors({ hull: 'coral', blade: 'teal' }, COLORS_PLAYER)
    const coral = HULLS.find(h => h.id === 'coral')!
    const teal = BLADES.find(b => b.id === 'teal')!
    expect(colors).toEqual({ ...COLORS_PLAYER, hull: coral.hull, trim: coral.trim, blade: teal.blade, oar: teal.oar })
  })

  it('모르는 id면 기본 스킨으로 — 기본 지갑은 플레이어 색 그대로', () => {
    expect(playerRigColors({ hull: 'nope', blade: 'nope' }, COLORS_PLAYER)).toEqual(COLORS_PLAYER)
    expect(playerRigColors(emptyWallet(), COLORS_PLAYER)).toEqual(COLORS_PLAYER)
  })
})

describe('addCoins', () => {
  it('내림해서 더하고 번 총액도 함께 는다', () => {
    const w = addCoins(wallet({ coins: 5, earned: 50 }), 10.9)
    expect(w.coins).toBe(15)
    expect(w.earned).toBe(60)
  })

  it('음수·1 미만은 무시한다', () => {
    const w = wallet({ coins: 5, earned: 50 })
    expect(addCoins(w, -20)).toEqual(w)
    expect(addCoins(w, 0.5)).toEqual(w)
  })
})

describe('출석', () => {
  it('previousDay는 달·해 경계를 넘고 윤년을 안다', () => {
    expect(previousDay('2026-11-10')).toBe('2026-11-09')
    expect(previousDay('2026-03-01')).toBe('2026-02-28')
    expect(previousDay('2024-03-01')).toBe('2024-02-29')
    expect(previousDay('2026-01-01')).toBe('2025-12-31')
  })

  it('첫 완주는 연속 1일, 보너스 없음', () => {
    const r = touchDay(wallet(), '2026-11-10')
    expect(r).toMatchObject({ streak: 1, bonus: 0, newDay: true })
    expect(r.wallet).toMatchObject({ lastDay: '2026-11-10', streak: 1 })
  })

  it('같은 날 두 번째 완주는 그대로', () => {
    const w = wallet({ lastDay: '2026-11-10', streak: 3 })
    const r = touchDay(w, '2026-11-10')
    expect(r).toEqual({ wallet: w, streak: 3, bonus: 0, newDay: false })
    expect(r.wallet).toBe(w)
  })

  it('다음 날이면 +1, 보너스는 (연속일 − 1) × 10', () => {
    const r = touchDay(wallet({ lastDay: '2026-11-10', streak: 3 }), '2026-11-11')
    expect(r).toMatchObject({ streak: 4, bonus: 30, newDay: true })
    expect(r.wallet.lastDay).toBe('2026-11-11')
    expect(r.wallet.streak).toBe(4)
    // 달 경계도 연속
    expect(touchDay(wallet({ lastDay: '2026-11-30', streak: 1 }), '2026-12-01')).toMatchObject({ streak: 2, bonus: 10 })
  })

  it('하루라도 건너뛰면 1로 돌아간다', () => {
    const r = touchDay(wallet({ lastDay: '2026-11-08', streak: 9 }), '2026-11-10')
    expect(r).toMatchObject({ streak: 1, bonus: 0, newDay: true })
    expect(r.wallet.lastDay).toBe('2026-11-10')
  })

  it('보너스는 50에서 멈춘다 — 6일째부터', () => {
    expect(touchDay(wallet({ lastDay: '2026-11-10', streak: 4 }), '2026-11-11').bonus).toBe(40)
    expect(touchDay(wallet({ lastDay: '2026-11-10', streak: 5 }), '2026-11-11').bonus).toBe(50)
    expect(touchDay(wallet({ lastDay: '2026-11-10', streak: 30 }), '2026-11-11').bonus).toBe(COIN_RULES.streakMax)
  })

  it('보너스는 지갑에 아직 더해지지 않는다', () => {
    const r = touchDay(wallet({ coins: 7, lastDay: '2026-11-10', streak: 2 }), '2026-11-11')
    expect(r.bonus).toBe(20)
    expect(r.wallet.coins).toBe(7)
    expect(r.wallet.earned).toBe(0)
  })
})

describe('CoinLedger', () => {
  it('거리 코인은 100m마다 1 — 첫 호출은 기준점만 잡고, 내역에는 내림한 정수로 보인다', () => {
    const l = new CoinLedger()
    l.addDistance(0, 1)
    expect(l.total).toBe(0)
    expect(l.entries()).toEqual([])
    l.addDistance(250, 1)
    expect(l.distanceTotal).toBe(2)
    expect(l.total).toBe(2)
    expect(l.entries()).toEqual([{ label: '거리', coins: 2 }])
  })

  it('기준점을 늦게 잡아도 그 이전 거리는 세지 않는다', () => {
    const l = new CoinLedger()
    l.addDistance(1000, 1)
    l.addDistance(1100, 1)
    expect(l.distanceTotal).toBe(1)
  })

  it('날씨 배율은 늘어난 거리에만 곱하고, 1 미만 배율은 1로 본다', () => {
    const l = new CoinLedger()
    l.addDistance(0, 1)
    l.addDistance(100, 2)      // 눈 ×2 → 2
    expect(l.distanceTotal).toBe(2)
    l.addDistance(200, 0.5)    // ×1로 → +1
    expect(l.distanceTotal).toBe(3)
    l.addDistance(300, 3)      // 무지개 ×3 → +3
    expect(l.distanceTotal).toBe(6)
  })

  it('거리가 줄면(되감김) 더하지 않고 그 자리를 새 기준으로 삼는다', () => {
    const l = new CoinLedger()
    l.addDistance(0, 1)
    l.addDistance(500, 1)
    l.addDistance(100, 1)
    expect(l.distanceTotal).toBe(5)
    l.addDistance(200, 1)
    expect(l.distanceTotal).toBe(6)
  })

  it('항목은 같은 라벨끼리 합치고, 0 이하는 무시하며, 거리가 맨 앞에 온다', () => {
    const l = new CoinLedger()
    l.add('파워 구간', COIN_RULES.zoneSuccess)
    l.add('파워 구간', COIN_RULES.zoneSuccess)
    l.add('완주', COIN_RULES.completion)
    l.add('없음', 0)
    l.add('음수', -5)
    l.addDistance(0, 1)
    l.addDistance(1234, 1)
    expect(l.entries()).toEqual([
      { label: '거리', coins: 12 },
      { label: '파워 구간', coins: 2 * COIN_RULES.zoneSuccess },
      { label: '완주', coins: COIN_RULES.completion },
    ])
    expect(l.total).toBe(12 + 2 * COIN_RULES.zoneSuccess + COIN_RULES.completion)
  })

  it('거리 코인이 1 미만이면 내역에 거리 줄이 없다', () => {
    const l = new CoinLedger()
    l.addDistance(0, 1)
    l.addDistance(99, 1)
    l.add('완주', 50)
    expect(l.entries()).toEqual([{ label: '완주', coins: 50 }])
    expect(l.total).toBe(50)
  })

  it('reset으로 비우고, 다음 addDistance는 다시 기준점만 잡는다', () => {
    const l = new CoinLedger()
    l.addDistance(0, 1)
    l.addDistance(1000, 1)
    l.add('완주', 50)
    l.reset()
    expect(l.total).toBe(0)
    expect(l.entries()).toEqual([])
    l.addDistance(5000, 1)
    expect(l.total).toBe(0)
    l.addDistance(5100, 1)
    expect(l.total).toBe(1)
  })
})
