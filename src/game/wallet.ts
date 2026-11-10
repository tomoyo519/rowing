import type { RigColors } from '../three/rig'

/**
 * 코인 지갑과 해금 — 세션을 넘어가는 동기.
 *
 * 완주·거리·콤보·파워 구간·체크포인트·백조·심박 부스트로 코인을 모아 보트 색과 노 색을 산다.
 * 지갑은 이 브라우저(localStorage)에 남는다. 기록처럼 브라우저 데이터를 지우면 함께 사라진다.
 *
 * 코인 규칙은 한곳(COIN_RULES)에 모아 둔다 — 요약 화면의 내역과 실제 적립이 어긋나지 않게 CoinLedger가 같은 상수를 쓴다.
 */
export const WALLET_KEY = 'makeRowing.wallet.v1'

export interface HullSkin {
  id: string
  label: string
  cost: number
  hull: string
  trim: string
}

export interface BladeSkin {
  id: string
  label: string
  cost: number
  blade: string
  oar: string
}

/** 선체 색. 첫 항목은 기본(무료)이고 rig.ts의 COLORS_PLAYER와 같다 */
export const HULLS: readonly HullSkin[] = [
  { id: 'navy', label: '네이비', cost: 0, hull: '#112b40', trim: '#dce5e8' },
  { id: 'coral', label: '코랄', cost: 120, hull: '#c2412f', trim: '#f5e1d6' },
  { id: 'forest', label: '포레스트', cost: 160, hull: '#1f5a3a', trim: '#d8ead9' },
  { id: 'sunset', label: '선셋', cost: 200, hull: '#d97a2b', trim: '#ffe8c7' },
  { id: 'violet', label: '바이올렛', cost: 260, hull: '#4a2d82', trim: '#e3dcf7' },
  { id: 'carbon', label: '카본', cost: 320, hull: '#1a1d22', trim: '#9aa3ad' },
  { id: 'gold', label: '골드', cost: 500, hull: '#b8892e', trim: '#fff1c4' },
]

/** 노 색. 첫 항목은 기본(무료) */
export const BLADES: readonly BladeSkin[] = [
  { id: 'white', label: '화이트', cost: 0, blade: '#e8edef', oar: '#172737' },
  { id: 'red', label: '레드', cost: 80, blade: '#e2475a', oar: '#2a1b1e' },
  { id: 'teal', label: '틸', cost: 100, blade: '#35c2a5', oar: '#15302c' },
  { id: 'yellow', label: '옐로', cost: 120, blade: '#ffd166', oar: '#3a2e10' },
  { id: 'gold', label: '골드', cost: 300, blade: '#e0a33a', oar: '#4a3610' },
]

export const COIN_RULES = {
  /** 100m마다 1코인 (날씨 배율이 곱해진다) */
  perMeter: 1 / 100,
  completion: 50,
  zoneSuccess: 30,
  /** 페이스 보트보다 앞선 채 체크포인트를 지나면 */
  checkpointLead: 5,
  swans: 15,
  hrBoost: 20,
  combo: { 10: 5, 25: 10, 50: 20, 100: 50, 200: 100 } as Record<number, number>,
  /** 오늘의 도전을 완주하면 총액에 곱한다 */
  dailyMult: 1.5,
  /** 연속 출석 보너스: (연속일 − 1) × 10, 최대 50 */
  streakPerDay: 10,
  streakMax: 50,
} as const

export interface WalletState {
  coins: number
  /** 지금까지 번 코인 총액 (쓴 것 포함) */
  earned: number
  unlocked: string[]
  hull: string
  blade: string
  /** 마지막으로 완주한 날 (YYYY-MM-DD, KST) */
  lastDay: string | null
  /** 연속 완주 일수 */
  streak: number
}

export function emptyWallet(): WalletState {
  return { coins: 0, earned: 0, unlocked: ['hull:navy', 'blade:white'], hull: 'navy', blade: 'white', lastDay: null, streak: 0 }
}

export function loadWallet(): WalletState {
  try {
    const raw = localStorage.getItem(WALLET_KEY)
    if (!raw) return emptyWallet()
    const parsed = JSON.parse(raw) as Partial<WalletState>
    const base = emptyWallet()
    return {
      coins: Number.isFinite(parsed.coins) ? Math.max(0, Math.floor(parsed.coins!)) : 0,
      earned: Number.isFinite(parsed.earned) ? Math.max(0, Math.floor(parsed.earned!)) : 0,
      unlocked: Array.isArray(parsed.unlocked) ? [...new Set([...base.unlocked, ...parsed.unlocked.filter(x => typeof x === 'string')])] : base.unlocked,
      hull: typeof parsed.hull === 'string' && HULLS.some(h => h.id === parsed.hull) ? parsed.hull : 'navy',
      blade: typeof parsed.blade === 'string' && BLADES.some(b => b.id === parsed.blade) ? parsed.blade : 'white',
      lastDay: typeof parsed.lastDay === 'string' ? parsed.lastDay : null,
      streak: Number.isFinite(parsed.streak) ? Math.max(0, Math.floor(parsed.streak!)) : 0,
    }
  } catch {
    return emptyWallet()
  }
}

export function saveWallet(w: WalletState) {
  try { localStorage.setItem(WALLET_KEY, JSON.stringify(w)) } catch { /* 저장소 미지원 — 이번 세션만 */ }
}

export type SkinKey = `hull:${string}` | `blade:${string}`

export function skinKey(kind: 'hull' | 'blade', id: string): SkinKey { return `${kind}:${id}` }

export function isUnlocked(w: WalletState, kind: 'hull' | 'blade', id: string) {
  return w.unlocked.includes(skinKey(kind, id))
}

/** 살 수 있으면 산 뒤의 지갑을, 아니면 null. 이미 가진 건 그대로 돌려준다(선택만 바뀐다) */
export function buySkin(w: WalletState, kind: 'hull' | 'blade', id: string): WalletState | null {
  const item = kind === 'hull' ? HULLS.find(h => h.id === id) : BLADES.find(b => b.id === id)
  if (!item) return null
  if (isUnlocked(w, kind, id)) return selectSkin(w, kind, id)
  if (w.coins < item.cost) return null
  const next = { ...w, coins: w.coins - item.cost, unlocked: [...w.unlocked, skinKey(kind, id)] }
  return selectSkin(next, kind, id)
}

export function selectSkin(w: WalletState, kind: 'hull' | 'blade', id: string): WalletState {
  if (!isUnlocked(w, kind, id)) return w
  return kind === 'hull' ? { ...w, hull: id } : { ...w, blade: id }
}

/** 지갑의 선택을 리그 색에 입힌다. base는 기본 플레이어 색(COLORS_PLAYER) */
export function playerRigColors(w: Pick<WalletState, 'hull' | 'blade'>, base: RigColors): RigColors {
  const hull = HULLS.find(h => h.id === w.hull) ?? HULLS[0]!
  const blade = BLADES.find(b => b.id === w.blade) ?? BLADES[0]!
  return { ...base, hull: hull.hull, trim: hull.trim, blade: blade.blade, oar: blade.oar }
}

/** 코인을 더한다 (음수 불가) */
export function addCoins(w: WalletState, coins: number): WalletState {
  const c = Math.max(0, Math.floor(coins))
  return { ...w, coins: w.coins + c, earned: w.earned + c }
}

/** YYYY-MM-DD 하루 전 */
export function previousDay(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * 완주한 날을 찍고 연속 출석을 센다. 같은 날 두 번째 완주는 그대로다.
 * 돌려주는 bonus는 이번 완주에 붙는 출석 보너스 코인(지갑에는 아직 안 더해졌다).
 */
export function touchDay(w: WalletState, dayKey: string): { wallet: WalletState; streak: number; bonus: number; newDay: boolean } {
  if (w.lastDay === dayKey) return { wallet: w, streak: w.streak, bonus: 0, newDay: false }
  const streak = w.lastDay === previousDay(dayKey) ? w.streak + 1 : 1
  const bonus = Math.min(COIN_RULES.streakMax, Math.max(0, streak - 1) * COIN_RULES.streakPerDay)
  return { wallet: { ...w, lastDay: dayKey, streak }, streak, bonus, newDay: true }
}

export interface LedgerEntry {
  label: string
  coins: number
}

/** 한 세션의 코인 내역. 거리 코인은 소수로 쌓다가 내역에는 정수로 보인다 */
export class CoinLedger {
  private distanceCoins = 0
  private lastDistance: number | null = null
  readonly extras: LedgerEntry[] = []

  /** 매 프레임: 늘어난 거리에 날씨 배율을 곱해 쌓는다 */
  addDistance(distance: number, mult: number) {
    if (this.lastDistance === null) { this.lastDistance = distance; return }
    const gained = Math.max(0, distance - this.lastDistance)
    this.lastDistance = distance
    this.distanceCoins += gained * COIN_RULES.perMeter * Math.max(1, mult)
  }

  /** 달리지 않는 동안(대기·끊김) 거리 기준만 맞춘다 — 그 사이 늘어난 거리는 코인이 아니다 */
  mark(distance: number) { this.lastDistance = distance }

  add(label: string, coins: number) {
    if (coins <= 0) return
    const existing = this.extras.find(e => e.label === label)
    if (existing) existing.coins += coins
    else this.extras.push({ label, coins })
  }

  get distanceTotal() { return Math.floor(this.distanceCoins) }
  get total() { return this.distanceTotal + this.extras.reduce((a, e) => a + e.coins, 0) }

  /** 요약에 보여줄 내역 — 거리가 맨 앞 */
  entries(): LedgerEntry[] {
    const out: LedgerEntry[] = []
    if (this.distanceTotal > 0) out.push({ label: '거리', coins: this.distanceTotal })
    return [...out, ...this.extras]
  }

  reset() {
    this.distanceCoins = 0
    this.lastDistance = null
    this.extras.length = 0
  }
}
