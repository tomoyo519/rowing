import {
  loadHistory, deleteRecord, totals, personalBest, type SessionRecord,
} from '../game/history'
import { COURSES } from '../game/courses'
import { formatSplit, formatClock } from '../game/physics'
import { deltaChipHtml, escapeHtml, renderSplitChart } from './charts'

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
  ].map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')

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
    const byId = new Map(history.map(r => [r.id, r]))

    for (const el of list.querySelectorAll<HTMLElement>('.hrow')) {
      el.addEventListener('click', ev => {
        const target = ev.target as HTMLElement
        if (target.classList.contains('link-btn') || target.closest('.htable') || target.closest('.hchart')) return
        el.classList.toggle('open')
        // 폭을 재서 그리므로 펼쳐진 뒤에 그린다
        if (el.classList.contains('open')) drawChart(el, byId)
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
    // 화면이 돌아가면 펼쳐진 차트를 새 폭으로 다시 그린다
    resizeObserver?.disconnect()
    resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      for (const el of list.querySelectorAll<HTMLElement>('.hrow.open')) drawChart(el, byId)
    })
    resizeObserver?.observe(list)
  }

  const back = document.getElementById('btn-hist-back')!
  back.onclick = onBack
}

let resizeObserver: ResizeObserver | null = null

function drawChart(rowEl: HTMLElement, byId: Map<string, SessionRecord>) {
  const host = rowEl.querySelector<HTMLElement>('.hchart-host')
  const record = byId.get(host?.dataset.id ?? '')
  if (!host || !record) return
  const width = host.clientWidth
  if (host.dataset.width === String(width) && host.childElementCount > 0) return
  host.dataset.width = String(width)
  renderSplitChart(host, {
    id: `h-${record.id}`,
    curve: record.curve,
    baseSplit: Number(record.baseSplit),
    course: COURSES.find(c => c.id === record.courseId) ?? null,
    durationSec: record.durationSec,
  })
}

function row(r: SessionRecord, isPb: boolean): string {
  const base = Number(r.baseSplit)
  const splitDelta = isFinite(base) && isFinite(r.avgSplit) ? deltaChipHtml(r.avgSplit - base, 's', '목표 대비', false) : ''
  return `
  <div class="hrow">
    <div class="hrow-top">
      <div>
        <span class="nm">${escapeHtml(r.courseName)}</span>
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
      <div class="hchart-host" data-id="${escapeHtml(r.id)}"></div>
      <div class="chips" style="margin:12px 0 0">
        ${splitDelta}
        ${deltaChipHtml(r.gap, 'm', '페이스 보트 대비')}
      </div>
      <div class="sub" style="margin-top:12px">
        <span>평균 파워 <b>${Math.round(r.avgPower)}</b>W</span>
        <span>스트로크 <b>${r.strokeCount}</b></span>
      </div>
      <div class="hrow-actions">
        <button class="link-btn" data-id="${escapeHtml(r.id)}">이 기록 삭제</button>
      </div>
    </div>
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
