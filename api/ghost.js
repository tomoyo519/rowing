// Vercel 서버리스 함수 — 친구 고스트. 기록 하나(1분 간격 스플릿 곡선 + 거리·시간)를 짧은 id로 저장하고 링크로 나눈다.
//   POST /api/ghost     { name, courseId, courseName, distance, elapsed, avgSplit, curve, mode, at }  (헤더 x-makerowing: 1) → { id }
//   GET  /api/ghost?id  → 저장한 JSON
// 별명과 기록 숫자만 받는다. id는 10자리 무작위라 주소를 아는 사람만 연다.
import { put, get } from '@vercel/blob'
import { randomBytes } from 'node:crypto'

const PREFIX = 'ghosts/'
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_CURVE = 240
const MODES = new Set(['classic', 'shark', 'chase'])

function newId() {
  const bytes = randomBytes(10)
  let id = ''
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length]
  return id
}

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

function sanitizeName(name) {
  // eslint-disable-next-line no-control-regex
  return String(name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 12) || '친구'
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
    const { courseId, distance, elapsed, curve } = body
    if (typeof courseId !== 'string' || !/^[a-z0-9-]{1,40}$/.test(courseId)) { res.status(400).json({ error: 'bad-course' }); return }
    if (typeof distance !== 'number' || !(distance >= 50) || distance > 60000) { res.status(400).json({ error: 'bad-distance' }); return }
    if (typeof elapsed !== 'number' || !(elapsed >= 60) || elapsed > 7200) { res.status(400).json({ error: 'bad-elapsed' }); return }
    if (!Array.isArray(curve) || curve.length > MAX_CURVE) { res.status(400).json({ error: 'bad-curve' }); return }
    const cleanCurve = curve
      .filter(p => p && typeof p.t === 'number' && typeof p.split === 'number' && isFinite(p.t) && isFinite(p.split))
      .map(p => ({ t: Math.round(p.t), split: Math.round(p.split * 10) / 10 }))

    const id = newId()
    const ghost = {
      id,
      name: sanitizeName(body.name),
      courseId,
      courseName: String(body.courseName ?? '').slice(0, 40),
      distance: Math.round(distance),
      elapsed: Math.round(elapsed),
      avgSplit: typeof body.avgSplit === 'number' && isFinite(body.avgSplit) ? Math.round(body.avgSplit * 10) / 10 : (elapsed / distance) * 500,
      curve: cleanCurve,
      mode: MODES.has(body.mode) ? body.mode : undefined,
      at: typeof body.at === 'string' && !isNaN(Date.parse(body.at)) ? body.at : new Date().toISOString(),
    }
    await put(`${PREFIX}${id}.json`, JSON.stringify(ghost), {
      access: 'private', addRandomSuffix: false, contentType: 'application/json',
    })
    res.status(200).json({ id })
    return
  }

  if (req.method === 'GET') {
    const id = typeof req.query.id === 'string' && /^[A-Za-z0-9_-]{4,24}$/.test(req.query.id) ? req.query.id : null
    if (!id) { res.status(400).json({ error: 'bad-id' }); return }
    try {
      const got = await get(`${PREFIX}${id}.json`, { access: 'private' })
      if (!got) { res.status(404).json({ error: 'not-found' }); return }
      const text = await new Response(got.stream).text()
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'public, max-age=3600')
      res.status(200).send(text)
    } catch {
      res.status(404).json({ error: 'not-found' })
    }
    return
  }

  res.setHeader('allow', 'GET, POST')
  res.status(405).json({ error: 'method-not-allowed' })
}
