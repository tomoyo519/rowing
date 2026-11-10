// Vercel 서버리스 함수 — 앱이 보낸 Bluetooth 진단 로그·세션 궤적을 Vercel Blob에 저장하고, 나중에 키로 읽는다.
// 실기기는 집에, 확인하는 사람은 다른 곳에 있어도 로그를 받을 수 있게 한다.
//   POST /api/log                      본문(text/plain) 저장 → { url, bytes }   (헤더 x-makerowing: 1 필요)
//   GET  /api/log?key=K                최근 로그 목록(JSON)
//   GET  /api/log?key=K&latest=1       가장 최근 로그 본문(text)
//   GET  /api/log?key=K&n=3            최근 3개 본문을 이어서(text)
// 스토어는 Private으로 만들었으므로 blob도 private으로 쓰고, 읽을 때는 SDK get()으로 토큰을 써서 가져온다.
// 환경변수: BLOB_STORE_ID(+Vercel OIDC) 또는 BLOB_READ_WRITE_TOKEN — Storage에서 스토어를 프로젝트에 연결하면 자동 추가,
//           LOG_READ_KEY (읽기 키 — 대시보드에서 직접 설정)
import { put, list, get } from '@vercel/blob'

const PREFIX = 'ble-logs/'
const MAX_BYTES = 512 * 1024

async function readBody(req) {
  if (typeof req.body === 'string') return req.body
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8')
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body)
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

export default async function handler(req, res) {
  // 스토어를 프로젝트에 연결하면 요즘은 읽기·쓰기 토큰 대신 BLOB_STORE_ID + Vercel OIDC 토큰이 들어온다. SDK가 둘 다 알아서 쓴다.
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    res.status(503).json({ error: 'blob-not-configured', hint: 'Vercel 대시보드 → Storage → Blob 스토어를 이 프로젝트에 연결한 뒤 다시 배포하세요' })
    return
  }

  if (req.method === 'POST') {
    if (req.headers['x-makerowing'] !== '1') { res.status(403).json({ error: 'forbidden' }); return }
    const text = await readBody(req)
    if (!text || !text.trim()) { res.status(400).json({ error: 'empty' }); return }
    const body = text.length > MAX_BYTES ? text.slice(-MAX_BYTES) : text
    const name = `${PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    const blob = await put(name, body, { access: 'private', addRandomSuffix: true, contentType: 'text/plain; charset=utf-8' })
    res.status(200).json({ url: blob.url, bytes: body.length })
    return
  }

  if (req.method === 'GET') {
    const key = process.env.LOG_READ_KEY
    if (!key) { res.status(503).json({ error: 'read-key-not-configured', hint: 'Vercel 환경변수 LOG_READ_KEY를 설정한 뒤 다시 배포하세요' }); return }
    if (req.query.key !== key) { res.status(403).json({ error: 'forbidden' }); return }
    const { blobs } = await list({ prefix: PREFIX, limit: 100 })
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
    const n = Number(req.query.n ?? (req.query.latest ? 1 : 0))
    if (n > 0) {
      const parts = []
      for (const blob of blobs.slice(0, n)) {
        const got = await get(blob.url, { access: 'private' })
        const text = got ? await new Response(got.stream).text() : '(읽기 실패)'
        parts.push(`===== ${blob.pathname} (${blob.uploadedAt}) =====\n${text}`)
      }
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.status(200).send(parts.join('\n\n'))
      return
    }
    res.status(200).json({
      count: blobs.length,
      logs: blobs.map(b => ({ url: b.url, pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt })),
    })
    return
  }

  res.setHeader('allow', 'GET, POST')
  res.status(405).json({ error: 'method-not-allowed' })
}
