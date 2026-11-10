import type { ArcadeSummary } from './arcade'
import type { SessionRecord } from '../game/history'
import { loadNickname, saveNickname, submitDaily, NICKNAME_MAX } from '../game/daily'
import { shareRecord } from '../game/friendGhost'
import { formatClock, formatSplitShort } from '../game/physics'
import { deltaChipHtml, escapeHtml } from './charts'
import { showLeaderboard } from './garage'

/**
 * 요약 화면의 재미 요소 블록 — 코인 내역, 콤보·파워 구간·백조·체크포인트 타일, 랜드마크 통과표,
 * 오늘의 도전 순위표 올리기, 친구 고스트 공유 링크.
 */
export interface SummaryContext {
  /** 저장된 기록. 너무 짧아 저장하지 않았으면 null */
  record: SessionRecord | null
  completed: boolean
  build: string
}

export function renderArcadeSummary(host: HTMLElement, s: ArcadeSummary, ctx: SummaryContext) {
  const parts: string[] = []

  if (s.coinsTotal > 0) {
    parts.push(`
    <div class="card arc-coins">
      <div class="arc-coins-head">
        <span class="k">이번 세션 코인</span>
        <b class="num">+${s.coinsTotal}</b>
        <span class="arc-wallet">지갑 <b class="num">${s.walletCoins}</b>${s.streak >= 2 ? ` · 연속 ${s.streak}일` : ''}</span>
      </div>
      <div class="chips">${s.entries.map(e => `<span class="delta flat"><i>●</i><b class="num">+${e.coins}</b><span>${escapeHtml(e.label)}</span></span>`).join('')}</div>
    </div>`)
  }

  const tiles: [string, string][] = []
  if (s.strokes > 0) tiles.push(['최장 콤보', `${s.comboBest}<span>· 좋은 스트로크 ${s.goodStrokes}/${s.strokes}</span>`])
  if (s.zones.attempted > 0) tiles.push(['파워 구간', `${s.zones.successes}<span>/ ${s.zones.attempted} 성공</span>`])
  if (s.swans.attempts > 0) tiles.push(['백조 떼', `${s.swans.successes}<span>/ ${s.swans.attempts} 통과</span>`])
  if (s.checkpoints.length > 0) tiles.push(['체크포인트 리드', `${s.checkpoints.filter(p => p.gap >= 0).length}<span>/ ${s.checkpoints.length}</span>`])
  if (s.hrBoosts > 0) tiles.push(['심박 부스트', `${s.hrBoosts}<span>회</span>`])
  if (tiles.length) {
    parts.push(`<div class="tiles arc-tiles">${tiles.map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>`)
  }

  if (s.checkpoints.length) {
    const ghostName = s.friendGhostName ? `친구 ${escapeHtml(s.friendGhostName)}` : '내 최고'
    const hasGhost = s.checkpoints.some(p => p.ghostGap !== null)
    parts.push(`
    <details class="htable arc-cp">
      <summary>랜드마크 통과 기록 (${s.checkpoints.length})</summary>
      <table>
        <thead><tr><th>랜드마크</th><th>시각</th><th>구간 스플릿</th><th>페이스 보트</th>${hasGhost ? `<th>${ghostName}</th>` : ''}</tr></thead>
        <tbody>${s.checkpoints.map(p => `<tr>
          <td>${escapeHtml(p.name)}</td>
          <td class="num">${formatClock(p.elapsed)}</td>
          <td class="num">${formatSplitShort(p.legSplit)}</td>
          <td>${deltaChipHtml(p.gap, 'm', '')}</td>
          ${hasGhost ? `<td>${p.ghostGap === null ? '—' : deltaChipHtml(p.ghostGap, 'm', '')}</td>` : ''}
        </tr>`).join('')}</tbody>
      </table>
    </details>`)
  }

  const actions: string[] = []
  if (s.daily && ctx.completed && ctx.record) {
    actions.push(`
    <div class="arc-daily">
      <div class="arc-daily-head"><span class="k">오늘의 도전 · ${s.daily.label}</span><button class="link-btn" type="button" id="arc-board">순위표 보기</button></div>
      <div class="arc-daily-row">
        <input id="arc-nick" type="text" maxlength="${NICKNAME_MAX}" placeholder="별명" value="${escapeHtml(loadNickname())}" autocomplete="off">
        <button class="hr-btn" type="button" id="arc-submit">순위표에 올리기</button>
      </div>
      <div class="arc-status" id="arc-daily-status">별명은 순위표에만 보입니다 · 같은 기기의 더 좋은 기록만 남습니다</div>
    </div>`)
  }
  if (ctx.record) {
    actions.push(`
    <div class="arc-share">
      <button class="btn ghost" type="button" id="arc-share">친구에게 고스트 링크 보내기</button>
      <div class="arc-status" id="arc-share-out">링크를 연 친구는 같은 코스에서 이 기록과 나란히 탑니다.</div>
    </div>`)
  }
  if (actions.length) parts.push(`<div class="arc-actions">${actions.join('')}</div>`)

  host.innerHTML = parts.join('')
  host.hidden = parts.length === 0

  // ── 순위표 올리기 ──
  const submit = document.getElementById('arc-submit') as HTMLButtonElement | null
  submit?.addEventListener('click', async () => {
    const rec = ctx.record
    const daily = s.daily
    if (!rec || !daily) return
    const nickInput = document.getElementById('arc-nick') as HTMLInputElement
    saveNickname(nickInput.value)
    const name = loadNickname()
    const status = document.getElementById('arc-daily-status')!
    if (!name) { status.textContent = '별명을 먼저 적어 주세요'; nickInput.focus(); return }
    submit.disabled = true
    status.textContent = '올리는 중…'
    const r = await submitDaily({
      date: daily.date, name, distance: Math.round(rec.distance), courseId: rec.courseId, mode: rec.mode ?? 'classic',
      modeScore: rec.modeScore ?? 0, avgSplit: isFinite(rec.avgSplit) ? rec.avgSplit : 0,
    }, ctx.build)
    if (r.ok) {
      status.textContent = r.rank ? `올렸습니다 · 현재 ${r.rank}위` : '올렸습니다'
      submit.textContent = '올렸습니다'
    } else {
      status.textContent = `올리지 못했어요 (${r.error ?? '오류'})`
      submit.disabled = false
    }
  })
  document.getElementById('arc-board')?.addEventListener('click', () => { if (s.daily) void showLeaderboard(s.daily.date) })

  // ── 공유 링크 ──
  const share = document.getElementById('arc-share') as HTMLButtonElement | null
  share?.addEventListener('click', async () => {
    const rec = ctx.record
    if (!rec) return
    const out = document.getElementById('arc-share-out')!
    share.disabled = true
    out.textContent = '링크 만드는 중…'
    const name = loadNickname() || '친구'
    const r = await shareRecord(rec, name)
    if (!r) { out.textContent = '링크를 만들지 못했어요. 네트워크를 확인하세요.'; share.disabled = false; return }
    let copied = false
    try { await navigator.clipboard.writeText(r.url); copied = true } catch { /* 클립보드 미지원 */ }
    out.innerHTML = `<span class="arc-link">${escapeHtml(r.url)}</span> ${copied ? '· 복사했습니다' : '· 길게 눌러 복사하세요'}`
    share.textContent = '링크 만들었습니다'
  })
}
