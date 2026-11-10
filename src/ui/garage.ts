import { COURSES, PACE_TIERS } from '../game/courses'
import { gameModeById, type GameModeId } from '../game/modes'
import {
  dailyChallenge, dateLabel, fetchLeaderboard, kstDateKey, loadNickname, modeLabel, saveNickname, NICKNAME_MAX,
  type DailyChallenge, type LeaderboardEntry,
} from '../game/daily'
import { fetchSharedGhost, sharedGhostIdFromUrl, type SharedGhost } from '../game/friendGhost'
import { BLADES, HULLS, buySkin, isUnlocked, loadWallet, saveWallet, type WalletState } from '../game/wallet'
import { DEFAULT_MAX_HR, loadMaxHr, MAX_HR_MAX, MAX_HR_MIN, saveMaxHr, targetZoneForTier, ZONE_LABELS } from '../game/hrZone'
import { formatSplitShort } from '../game/physics'
import { escapeHtml } from './charts'

/**
 * 코스 선택 화면의 재미 요소 — 오늘의 도전 카드, 친구 고스트 배너, 내 보트(해금), 별명·최대 심박.
 * 그리고 순위표 패널. main.ts는 goCourseSelect에서 renderArcadeSelect(hooks)만 부른다.
 */
export interface Selection {
  courseId: string
  tierId: string
  mode: GameModeId
}

export interface SelectHooks {
  current(): Selection
  /** 오늘의 도전·친구 코스를 고르면 main이 선택을 바꾸고 화면을 다시 그린다 */
  pick(sel: Partial<Selection>): void
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null

// ── 친구 고스트 (링크로 들어온 기록) ──────────────────────
let sharedGhost: SharedGhost | null = null
let sharedGhostOn = true
let sharedGhostLoading = false

/** 앱 시작 시 한 번. `?ghost=id`가 있으면 받아 둔다 */
export async function loadSharedGhostFromUrl(onReady?: () => void) {
  const id = sharedGhostIdFromUrl()
  if (!id) return
  sharedGhostLoading = true
  sharedGhost = await fetchSharedGhost(id)
  sharedGhostLoading = false
  onReady?.()
}

/** 이 코스에 붙일 친구 고스트. 끈 상태거나 코스가 다르면 null */
export function friendGhostFor(courseId: string): SharedGhost | null {
  return sharedGhost && sharedGhostOn && sharedGhost.courseId === courseId ? sharedGhost : null
}

/** 지금 선택이 오늘의 도전과 같으면 그 도전 */
export function activeDaily(sel: Selection, dateKey = kstDateKey()): DailyChallenge | null {
  const d = dailyChallenge(dateKey)
  return d.courseId === sel.courseId && d.tierId === sel.tierId && d.mode === sel.mode ? d : null
}

export function renderArcadeSelect(hooks: SelectHooks) {
  renderTop(hooks)
  renderGarage()
}

function renderTop(hooks: SelectHooks) {
  const host = $('arcade-select')
  if (!host) return
  const sel = hooks.current()
  const d = dailyChallenge()
  const course = COURSES.find(c => c.id === d.courseId)
  const tier = PACE_TIERS.find(t => t.id === d.tierId)
  const active = activeDaily(sel) !== null
  const parts: string[] = []

  parts.push(`
  <div class="daily-card card${active ? ' sel' : ''}" id="daily-card">
    <div class="daily-head">
      <span class="k">오늘의 도전 · ${d.label}</span>
      <button class="link-btn" type="button" id="daily-board">순위표</button>
    </div>
    <div class="daily-body"><b>${escapeHtml(course?.name ?? d.courseId)}</b> · ${modeLabel(d.mode)} · ${tier ? `${tier.label} ${formatSplitShort(tier.split)}` : ''}</div>
    <div class="daily-sub">모두 같은 코스·상대·날씨로 탑니다. 완주하면 코인 1.5배, 결과는 별명으로 순위표에 올릴 수 있어요.</div>
    <button class="btn ghost daily-pick" type="button" id="daily-pick"${active ? ' disabled' : ''}>${active ? '선택됨 · 아래 시작을 누르세요' : '이 조건으로 도전하기'}</button>
  </div>`)

  if (sharedGhostLoading) {
    parts.push('<div class="friend-banner card"><div class="friend-text">친구 고스트를 불러오는 중…</div></div>')
  } else if (sharedGhost) {
    const g = sharedGhost
    const same = g.courseId === sel.courseId
    parts.push(`
    <div class="friend-banner card${sharedGhostOn && same ? ' sel' : ''}" id="friend-banner">
      <div class="friend-text">
        <b>친구 ${escapeHtml(g.name)}</b>의 고스트 · ${escapeHtml(g.courseName)} · ${(g.distance / 1000).toFixed(2)} km · ${formatSplitShort(g.avgSplit)}/500m
        <span class="friend-sub">${sharedGhostOn ? (same ? '이 코스를 타면 친구가 옆 레인에 섭니다 (내 최고 기록 대신)' : '아래 버튼으로 그 코스를 고르세요') : '꺼져 있어요'}</span>
      </div>
      <div class="friend-actions">
        ${!same || !sharedGhostOn ? '<button class="hr-btn" type="button" id="friend-pick">이 코스로 함께 타기</button>' : ''}
        <button class="link-btn" type="button" id="friend-toggle">${sharedGhostOn ? '끄기' : '켜기'}</button>
      </div>
    </div>`)
  }
  host.innerHTML = parts.join('')

  $('daily-pick')?.addEventListener('click', () => hooks.pick({ courseId: d.courseId, tierId: d.tierId, mode: d.mode }))
  $('daily-board')?.addEventListener('click', () => void showLeaderboard(d.date))
  $('friend-pick')?.addEventListener('click', () => {
    sharedGhostOn = true
    if (sharedGhost) hooks.pick({ courseId: sharedGhost.courseId })
  })
  $('friend-toggle')?.addEventListener('click', () => { sharedGhostOn = !sharedGhostOn; renderTop(hooks) })
}

// ── 내 보트·별명·최대 심박 ─────────────────────────────────
function renderGarage() {
  const host = $('garage')
  if (!host) return
  const w = loadWallet()
  const maxHr = loadMaxHr()
  const swatch = (kind: 'hull' | 'blade', id: string, label: string, cost: number, color: string, selected: boolean) => {
    const owned = isUnlocked(w, kind, id)
    const affordable = w.coins >= cost
    return `<button class="skin${selected ? ' sel' : ''}${owned ? '' : ' locked'}" type="button" data-kind="${kind}" data-id="${id}"
      aria-pressed="${selected}" ${!owned && !affordable ? 'disabled' : ''} title="${escapeHtml(label)}">
      <i style="background:${color}"></i><b>${escapeHtml(label)}</b><span>${owned ? (selected ? '사용 중' : '보유') : `${cost} 코인`}</span></button>`
  }
  host.innerHTML = `
  <div class="garage-head">
    <h2>내 보트</h2>
    <div class="garage-wallet"><span class="coin-ic">●</span><b class="num" id="garage-coins">${w.coins}</b> 코인${w.streak >= 2 ? ` · 연속 ${w.streak}일` : ''}</div>
  </div>
  <p class="tier-hint garage-hint">완주·거리·콤보·파워 구간·백조·심박 부스트로 코인을 모아 색을 삽니다. 궂은 날(비·눈·바람)과 무지개는 코인이 더 붙어요.</p>
  <div class="skin-row" role="group" aria-label="선체 색">${HULLS.map(h => swatch('hull', h.id, h.label, h.cost, h.hull, w.hull === h.id)).join('')}</div>
  <div class="skin-row" role="group" aria-label="노 색">${BLADES.map(b => swatch('blade', b.id, b.label, b.cost, b.blade, w.blade === b.id)).join('')}</div>
  <div class="garage-fields">
    <label class="field"><span>별명 <small>순위표·공유 링크에 보입니다</small></span><input id="nick-input" type="text" maxlength="${NICKNAME_MAX}" placeholder="별명" value="${escapeHtml(loadNickname())}" autocomplete="off"></label>
    <label class="field"><span>최대 심박 <small>심박 존 게이지 기준 · 모르면 220 − 나이</small></span><input id="maxhr-input" type="number" inputmode="numeric" min="${MAX_HR_MIN}" max="${MAX_HR_MAX}" value="${maxHr}"></label>
  </div>
  <p class="tier-hint garage-hint" id="hrz-hint"></p>`

  for (const btn of host.querySelectorAll<HTMLButtonElement>('.skin')) {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.kind as 'hull' | 'blade'
      const id = btn.dataset.id!
      const next = buySkin(loadWallet(), kind, id)
      if (!next) return
      saveWallet(next)
      renderGarage()
    })
  }
  const nick = $<HTMLInputElement>('nick-input')
  nick?.addEventListener('change', () => { saveNickname(nick.value); nick.value = loadNickname() })
  nick?.addEventListener('blur', () => { saveNickname(nick.value); nick.value = loadNickname() })
  const hr = $<HTMLInputElement>('maxhr-input')
  hr?.addEventListener('change', () => {
    const n = Number(hr.value)
    saveMaxHr(n >= MAX_HR_MIN && n <= MAX_HR_MAX ? n : DEFAULT_MAX_HR)
    hr.value = String(loadMaxHr())
    renderHrHint()
  })
  renderHrHint()
}

/** 현재 티어의 목표 존을 숫자로 — 심박 입력 아래 */
let hrHintTier = 'steady'
export function setGarageTier(tierId: string) { hrHintTier = tierId; renderHrHint() }
function renderHrHint() {
  const el = $('hrz-hint')
  if (!el) return
  const maxHr = loadMaxHr()
  const zone = targetZoneForTier(hrHintTier)
  const lo = Math.round(maxHr * [0, 0, 0.6, 0.7, 0.8, 0.9][zone]!)
  const hi = zone >= 5 ? maxHr : Math.round(maxHr * [0, 0.6, 0.7, 0.8, 0.9, 1][zone]!)
  el.textContent = `심박 센서가 있으면 레이스 중 Z${zone} ${ZONE_LABELS[zone]} 존(${lo}~${hi} bpm)에 2분 머물 때마다 10초 부스트와 코인을 줍니다.`
}

// ── 순위표 패널 ────────────────────────────────────────────
export async function showLeaderboard(date: string) {
  const panel = $('leaderboard')
  const list = $('lb-list')
  const title = $('lb-title')
  if (!panel || !list || !title) return
  panel.hidden = false
  title.textContent = `오늘의 도전 순위표 · ${dateLabel(date)}`
  list.innerHTML = '<div class="empty">불러오는 중…</div>'
  $('lb-close')?.addEventListener('click', () => { panel.hidden = true }, { once: true })
  const data = await fetchLeaderboard(date)
  if (!data) { list.innerHTML = '<div class="empty">순위표를 불러오지 못했어요.<br>네트워크나 서버 설정을 확인하세요.</div>'; return }
  if (!data.entries.length) { list.innerHTML = '<div class="empty">아직 아무도 올리지 않았어요.<br>오늘의 도전을 완주하고 첫 번째로 올려 보세요.</div>'; return }
  list.innerHTML = `<ol class="lb-rows">${data.entries.map((e, i) => row(e, i + 1)).join('')}</ol>
    <div class="lb-foot">${data.count}명 참가${data.count > data.entries.length ? ` · 상위 ${data.entries.length}명 표시` : ''}</div>`
}

function row(e: LeaderboardEntry, rank: number) {
  const mode = gameModeById(e.mode)
  const score = e.mode === 'shark' ? ` · 잡힘 ${e.modeScore}회` : e.mode === 'chase' ? ` · 추월 ${e.modeScore}명` : ''
  return `<li class="lb-row${e.mine ? ' mine' : ''}">
    <span class="lb-rank num">${rank}</span>
    <span class="lb-name">${escapeHtml(e.name || '익명')}${e.mine ? ' <i>나</i>' : ''}</span>
    <span class="lb-meta">${mode.id !== 'classic' ? mode.label : ''}${score}</span>
    <span class="lb-dist num"><b>${(e.distance / 1000).toFixed(2)}</b> km${e.avgSplit ? ` · ${formatSplitShort(e.avgSplit)}` : ''}</span>
  </li>`
}

export type { WalletState }
