import type { ZoneView } from '../game/powerZones'
import type { SwanView } from '../game/wildlife'
import { formatSplitShort } from '../game/physics'
import { ZONE_LABELS } from '../game/hrZone'

/**
 * 재미 요소 HUD — 오른쪽 세로 레일(콤보·코인·심박 존·파워 구간·백조)과 가운데 알림, 부스트 가장자리.
 *
 * raceHud.ts와 같은 원칙: DOM 쓰기는 값이 바뀔 때만, 블러 없음, 색만으로 뜻을 나르지 않는다(글리프·글자를 같이).
 * 요소 id는 index.html의 `.arcade-rail` 블록과 맞춘다.
 */
export type ToastTone = 'win' | 'warn' | 'danger' | 'info'

const TOAST_MS = 2400

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

export class ArcadeHud {
  private text = new Map<string, string>()
  private toastTimer: number | null = null
  private lastComboLevel = -1
  private lastZoneState: string | null = null
  private lastSwanOn = false
  private lastHrOn: boolean | null = null

  private setText(id: string, value: string) {
    if (this.text.get(id) === value) return
    this.text.set(id, value)
    $(id).textContent = value
  }

  start(opts: { hasHr: boolean; targetZone: number }) {
    this.text.clear()
    this.lastComboLevel = -1
    this.lastZoneState = null
    this.lastSwanOn = false
    this.lastHrOn = null
    this.hideToast()
    $('arcade-rail').hidden = false
    this.setCombo(0, 0, false)
    this.setCoins(0, 1, null)
    $('hrz').hidden = !opts.hasHr
    this.setText('hrz-k', `Z${opts.targetZone}`)
    this.setText('hrz-t', `${ZONE_LABELS[opts.targetZone] ?? ''} 존 유지`)
    $('hrz-fill').style.transform = 'scaleX(0)'
    $('zone-card').hidden = true
    $('swan-card').hidden = true
    $('boost-veil').classList.remove('on')
  }

  stop() {
    this.hideToast()
    $('arcade-rail').hidden = true
    $('boost-veil').classList.remove('on')
  }

  /** 콤보 숫자. bump면 한 번 튄다(좋은 스트로크마다) */
  setCombo(count: number, level: number, bump: boolean) {
    const chip = $('combo-chip')
    this.setText('combo-n', String(count))
    if (level !== this.lastComboLevel) {
      this.lastComboLevel = level
      chip.dataset.level = String(level)
    }
    if (bump) {
      chip.classList.remove('bump')
      void chip.offsetWidth
      chip.classList.add('bump')
    }
  }

  setComboBest(best: number) {
    this.setText('combo-best', best >= 10 ? `최장 ${best}` : '')
  }

  /** 코인 총액과 날씨 배율 */
  setCoins(total: number, mult: number, label: string | null) {
    this.setText('coin-n', String(Math.floor(total)))
    this.setText('coin-mult', label ? `${label} ×${Number.isInteger(mult) ? mult : mult.toFixed(1)}` : '')
    $('coin-chip').classList.toggle('bonus', !!label)
  }

  /** 코인이 들어왔다 — 칩이 한 번 반짝인다 */
  coinPop() {
    const chip = $('coin-chip')
    chip.classList.remove('bump')
    void chip.offsetWidth
    chip.classList.add('bump')
  }

  /** 심박 존 게이지. hr이 없으면 숨긴다(센서 없음) */
  setHr(state: { fill: number; zone: number | null; target: number; boosting: boolean } | null) {
    const on = state !== null
    if (on !== this.lastHrOn) {
      this.lastHrOn = on
      $('hrz').hidden = !on
    }
    if (!state) return
    $('hrz-fill').style.transform = `scaleX(${state.fill.toFixed(3)})`
    const rel = state.zone === null ? '' : state.zone === state.target ? '존 안' : state.zone < state.target ? '존 아래' : '존 위'
    this.setText('hrz-t', state.boosting ? '부스트!' : state.zone === null ? '심박 대기' : `Z${state.zone} · ${rel}`)
    const hrz = $('hrz')
    hrz.classList.toggle('in', state.zone === state.target)
    hrz.classList.toggle('over', state.zone !== null && state.zone > state.target)
    hrz.classList.toggle('boost', state.boosting)
    $('boost-veil').classList.toggle('on', state.boosting)
  }

  /** 파워 구간 카드 — 예고(soon)와 진행(active) */
  setZone(v: ZoneView | null) {
    const card = $('zone-card')
    const state = v?.state ?? null
    if (state !== this.lastZoneState) {
      this.lastZoneState = state
      card.hidden = v === null
      card.classList.toggle('active', state === 'active')
    }
    if (!v) return
    this.setText('zone-title', v.state === 'soon' ? '파워 구간 예고' : '파워 구간')
    this.setText('zone-rem', `${Math.ceil(v.remaining)}초`)
    $('zone-fill').style.transform = `scaleX(${(v.state === 'active' ? v.progress : 1 - v.remaining / 10).toFixed(3)})`
    if (v.state === 'soon') {
      this.setText('zone-sub', `30초 동안 목표보다 3초 빠르게`)
      card.classList.remove('ok', 'behind')
    } else {
      const ok = isFinite(v.delta) && v.delta <= -3
      const have = isFinite(v.avgSplit)
      this.setText('zone-sub', have
        ? `지금 ${formatSplitShort(v.avgSplit)} · 목표 ${formatSplitShort(v.targetSplit - 3)} · ${v.delta <= 0 ? '−' : '+'}${Math.abs(v.delta).toFixed(1)}초 ${ok ? '✓' : ''}`
        : `목표 ${formatSplitShort(v.targetSplit - 3)} 이하로`)
      card.classList.toggle('ok', ok)
      card.classList.toggle('behind', have && !ok)
    }
  }

  /** 백조 떼 카드 — 남은 시간과 거리 */
  setSwans(v: SwanView | null) {
    const on = v !== null
    if (on !== this.lastSwanOn) {
      this.lastSwanOn = on
      $('swan-card').hidden = !on
    }
    if (!v) return
    this.setText('swan-rem', `${Math.ceil(v.remaining)}초`)
    this.setText('swan-sub', v.along > 0 ? `앞으로 ${Math.round(v.along)}m` : '통과!')
    $('swan-fill').style.transform = `scaleX(${(1 - v.progress).toFixed(3)})`
    $('swan-card').classList.toggle('late', v.remaining < 3 && v.along > 0)
  }

  toast(title: string, sub: string, tone: ToastTone) {
    const el = $('arcade-toast')
    $('arcade-toast-t').textContent = title
    $('arcade-toast-s').textContent = sub
    el.className = `arcade-toast ${tone}`
    void el.offsetWidth
    el.classList.add('on')
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => { el.classList.remove('on'); this.toastTimer = null }, TOAST_MS)
  }

  hideToast() {
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer)
    this.toastTimer = null
    $('arcade-toast').classList.remove('on')
  }
}
