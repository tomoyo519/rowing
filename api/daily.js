// Vercel 서버리스 함수 — 오늘의 도전 순위표. 항목은 Vercel Blob에 하루·기기 단위 JSON 하나로 남는다.
//   POST /api/daily                  { date, name, distance, courseId, mode, modeScore, avgSplit, deviceId, build }  (헤더 x-makerowing: 1)
//                                    같은 기기의 더 좋은 기록만 남긴다 → { ok, rank, count, kept }
//   GET  /api/daily?date=YYYY-MM-DD&device=ID   그날 순위표 → { date, count, entries: [...상위 50] }
// 스토어는 Private이라 blob도 private으로 쓰고 SDK get()으로 읽는다. 별명 외의 개인정보는 받지 않는다.
import { put, list, get } from '@vercel/blob'

const PREFIX = 'daily/'
const TOP = 50
const MAX_ENTRIES = 300
const NAME_MAX = 12
const MODES = new Set(['classic', 'shark', 'chase'])

async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body
  let text = ''
  if (typeof req.body === 'string') text = req.body
  else if (Buffer.isBuffer(req.body)) text = req.body.toString('utf8')
  else {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    text = Buffer.concat(chunks).toString('utf8')
  }
  try { return JSON.parse(text) } catch { return null }
}

function kstDateKey(nowMs = Date.now()) {
  return new Date(nowMs + 9 * 3600 * 1000).toISOString().slice(0, 10)
}

function sanitizeName(name) {
  // eslint-disable-next-line no-control-regex
  return String(name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, NAME_MAX) || '익명'
}

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const today = kstDateKey()
  const yesterday = kstDateKey(Date.now() - 86400_000)
  return s === today || s === yesterday
}

function validDateForRead(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

async function readEntries(date) {
  const { blobs } = await list({ prefix: `${PREFIX}${date}/`, limit: MAX_ENTRIES })
  const out = []
  // 10개씩 병렬로 읽는다 — 순위표는 수십 명 규모를 가정한다
  for (let i = 0; i < blobs.length; i += 10) {
    const chunk = blobs.slice(i, i + 10)
    const got = await Promise.all(chunk.map(async b => {
      try {
        const r = await get(b.url, { access: 'private' })
        if (!r) return null
        const data = JSON.parse(await new Response(r.stream).text())
        return { ...data, device: b.pathname.slice(`${PREFIX}${date}/`.length).replace(/\.json$/, '') }
      } catch { return null }
    }))
    for (const e of got) if (e && typeof e.distance === 'number') out.push(e)
  }
  out.sort((a, b) => b.distance - a.distance || String(a.at).localeCompare(String(b.at)))
  return out
}

function publicEntry(e, device) {
  return {
    name: e.name, distance: e.distance, courseId: e.courseId, mode: e.mode, modeScore: e.modeScore ?? 0,
    avgSplit: e.avgSplit ?? null, at: e.at, mine: device ? e.device === device : undefined,
  }
}

export default async function handler(req, res) {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    res.status(503).json({ error: 'blob-not-configured' })
    return
  }

  if (req.method === 'POST') {
    if (req.headers['x-makerowing'] !== '1') { res.status(403).json({ error: 'forbidden' }); return }
    const body = await readJson(req)
    if (!body) { res.status(400).json({ error: 'bad-json' }); return }
    const { date, distance, courseId, mode, deviceId } = body
    if (!validDate(date)) { res.status(400).json({ error: 'bad-date' }); return }
    if (typeof distance !== 'number' || !(distance > 0) || distance > 30000) { res.status(400).json({ error: 'bad-distance' }); return }
    if (typeof courseId !== 'string' || !/^[a-z0-9-]{1,40}$/.test(courseId)) { res.status(400).json({ error: 'bad-course' }); return }
    if (!MODES.has(mode)) { res.status(400).json({ error: 'bad-mode' }); return }
    const device = typeof deviceId === 'string' && /^[0-9a-f]{16}$/.test(deviceId) ? deviceId : null
    if (!device) { res.status(400).json({ error: 'bad-device' }); return }

    const entry = {
      name: sanitizeName(body.name),
      distance: Math.round(distance),
      courseId, mode,
      modeScore: Number.isInteger(body.modeScore) && body.modeScore >= 0 && body.modeScore < 1000 ? body.modeScore : 0,
      avgSplit: typeof body.avgSplit === 'number' && body.avgSplit > 0 && body.avgSplit < 3000 ? Math.round(body.avgSplit * 10) / 10 : null,
      at: new Date().toISOString(),
      build: typeof body.build === 'string' ? body.build.slice(0, 40) : undefined,
    }
    const pathname = `${PREFIX}${date}/${device}.json`

    // 같은 기기의 기존 기록이 더 좋으면 그대로 둔다
    let kept = false
    try {
      const existing = await get(pathname, { access: 'private' })
      if (existing) {
        const prev = JSON.parse(await new Response(existing.stream).text())
        if (typeof prev.distance === 'number' && prev.distance >= entry.distance) kept = true
      }
    } catch { /* 없거나 못 읽음 — 새로 쓴다 */ }
    if (!kept) {
      await put(pathname, JSON.stringify(entry), {
        access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json',
      })
    }
    const entries = await readEntries(date)
    const rank = entries.findIndex(e => e.device === device) + 1
    res.status(200).json({ ok: true, kept, rank: rank > 0 ? rank : null, count: entries.length })
    return
  }

  if (req.method === 'GET') {
    const date = typeof req.query.date === 'string' && validDateForRead(req.query.date) ? req.query.date : kstDateKey()
    const device = typeof req.query.device === 'string' && /^[0-9a-f]{16}$/.test(req.query.device) ? req.query.device : null
    const entries = await readEntries(date)
    const mineIndex = device ? entries.findIndex(e => e.device === device) : -1
    res.setHeader('cache-control', 'no-store')
    res.status(200).json({
      date,
      count: entries.length,
      entries: entries.slice(0, TOP).map(e => publicEntry(e, device)),
      mine: mineIndex >= 0 ? { rank: mineIndex + 1, ...publicEntry(entries[mineIndex], device) } : null,
    })
    return
  }

  res.setHeader('allow', 'GET, POST')
  res.status(405).json({ error: 'method-not-allowed' })
}
