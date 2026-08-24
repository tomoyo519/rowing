import {
  loadHistory, deleteRecord, totals, personalBest, type SessionRecord,
} from '../game/history'
import { formatSplit, formatClock } from '../game/physics'

/** 기록 화면 렌더링 */
export function renderHistory(onBack: () => void) {
  const list = document.getElementById('hist-list')!
  const tot = document.getElementById('hist-totals')!
  const history = loadHistory()
  const t = totals(history)

  tot.innerHTML = [
    ['세션', `${t.sessions}`],
    ['총 거리', `${(t.distance / 1000).toFixed(1)}<span>km</span>`],
    ['총 시간', `${Math.round(t.seconds / 3600)}<span>h</span>`],
    ['총 스트로크', `${t.strokes.toLocaleString('ko-KR')}`],
  ].map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')

  if (!history.length) {
    list.innerHTML = '<div class="empty">아직 기록이 없습니다.<br>코스를 한 번 완주하면 여기에 쌓입니다.</div>'
  } else {
    // PB는 코스별로 한 번만 계산해서 재사용
    const pbByCourse = new Map<string, string>()
    for (const r of history) {
      if (!pbByCourse.has(r.courseId)) {
        const pb = personalBest(r.courseId, history)
        if (pb) pbByCourse.set(r.courseId, pb.id)
      }
    }

    list.innerHTML = history.map(r => row(r, pbByCourse.get(r.courseId) === r.id)).join('')

    for (const el of list.querySelectorAll<HTMLElement>('.hrow')) {
      el.addEventListener('click', ev => {
        if ((ev.target as HTMLElement).classList.contains('link-btn')) return
        el.classList.toggle('open')
      })
    }
    for (const btn of list.querySelectorAll<HTMLElement>('.link-btn')) {
      btn.addEventListener('click', ev => {
        ev.stopPropagation()
        const id = btn.dataset.id!
        deleteRecord(id)
        renderHistory(onBack)
      })
    }
  }

  const back = document.getElementById('btn-hist-back')!
  back.onclick = onBack
}

function row(r: SessionRecord, isPb: boolean): string {
  return `
  <div class="hrow">
    <div class="hrow-top">
      <div>
        <span class="nm">${esc(r.courseName)}</span>
        ${isPb ? '<span class="pb">PB</span>' : ''}
        ${r.completed ? '' : '<span class="dnf">중단</span>'}
      </div>
      <div class="when">${when(r.at)}</div>
    </div>
    <div class="sub">
      <span><b>${(r.distance / 1000).toFixed(2)}</b> km</span>
      <span><b>${formatClock(r.elapsed)}</b></span>
      <span><b>${formatSplit(r.avgSplit)}</b> /500m</span>
      <span><b>${r.avgSpm.toFixed(1)}</b> spm</span>
    </div>
    <div class="hrow-detail">
      ${curve(r)}
      <div class="sub" style="margin-top:12px">
        <span>평균 파워 <b>${Math.round(r.avgPower)}</b>W</span>
        <span>스트로크 <b>${r.strokeCount}</b></span>
        <span>페이스 보트 <b>${r.gap >= 0 ? '+' : ''}${Math.round(r.gap)}</b>m</span>
      </div>
      <div class="hrow-actions">
        <button class="link-btn" data-id="${r.id}">이 기록 삭제</button>
      </div>
    </div>
  </div>`
}

/** 스플릿 곡선. y축은 뒤집는다 — 스플릿이 작을수록 빠르므로 위가 빠른 쪽. */
function curve(r: SessionRecord): string {
  const pts = r.curve.filter(p => isFinite(p.split) && p.split > 0)
  if (pts.length < 2) return '<div class="hcurve-cap"><span>곡선을 그릴 기록이 부족합니다</span></div>'

  const W = 100, H = 40
  const splits = pts.map(p => p.split)
  const lo = Math.min(...splits), hi = Math.max(...splits)
  const span = hi - lo || 1
  const tMax = pts[pts.length - 1]!.t || 1

  const path = pts
    .map(p => `${(p.t / tMax) * W},${((p.split - lo) / span) * (H - 4) + 2}`)
    .join(' ')

  return `
    <div class="hchart">
      <svg class="hcurve" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="${path}" class="hcurve-line" />
      </svg>
      <span class="hy hy-top">${formatSplit(lo)}</span>
      <span class="hy hy-bot">${formatSplit(hi)}</span>
    </div>
    <div class="hcurve-cap">
      <span>0:00</span>
      <span>스플릿 추이 · 위가 빠름</span>
      <span>${formatClock(tMax)}</span>
    </div>`
}

function when(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const date = sameYear
    ? `${d.getMonth() + 1}월 ${d.getDate()}일`
    : `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`
  return `${date} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
