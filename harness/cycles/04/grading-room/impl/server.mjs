import { createServer as httpServer } from 'node:http'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { execute, newRecord } from './record.mjs'

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
}

export function createServer({ file, now = () => new Date(), allowClock = false } = {}) {
  let record = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : newRecord()
  if (!allowClock) record.clock = null
  return httpServer(async (req, res) => {
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(body)
    }
    const json = (status, body) => send(status, 'application/json; charset=utf-8', JSON.stringify(body))
    try {
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
        const [path, type] = assets[url.pathname]
        send(200, type, readFileSync(new URL(path, import.meta.url)))
        return
      }
      if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
        json(404, { reason: 'not_found', message: 'Page was not found.' })
        return
      }
      let body
      if (req.method === 'POST') {
        let length = 0
        const chunks = []
        for await (const chunk of req) {
          length += chunk.length
          if (length <= 65536) chunks.push(chunk)
        }
        if (length > 65536) {
          json(413, { reason: 'request_too_large', message: 'Request exceeds 64 KiB.' })
          return
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
          json(400, { reason: 'invalid_request', message: 'Submit valid JSON.' })
          return
        }
      }
      const path = url.pathname.slice(4).split('/').filter(Boolean).map(decodeURIComponent)
      // The command, file replacement, and publication are synchronous. No other
      // HTTP handler can observe a partially applied decision inside this process.
      const draft = structuredClone(record)
      const reply = execute(draft, now().getTime(), req.method, path, url.searchParams, body, allowClock)
      if (JSON.stringify(draft) !== JSON.stringify(record)) {
        if (file) {
          writeFileSync(file + '.next', JSON.stringify(draft), { mode: 0o600 })
          renameSync(file + '.next', file)
        }
        record = draft
      }
      json(reply.status, reply.body)
    } catch (error) {
      if (error instanceof URIError) {
        json(400, { reason: 'invalid_request', message: 'Invalid URL encoding.' })
        return
      }
      console.error(error)
      json(500, { reason: 'internal_error', message: 'The request could not be completed.' })
    }
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.argv[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Supply a port from 1 to 65535.')
  const file = process.env.LOYLY_RECORD || fileURLToPath(new URL('./.loyly-record.json', import.meta.url))
  const initial = process.env.LOYLY_DEMO_NOW
  if (initial && !Number.isFinite(Date.parse(initial))) throw new Error('LOYLY_DEMO_NOW requires a valid instant.')
  const server = createServer({ file, ...(initial && { now: () => new Date(initial), allowClock: true }) })
  server.listen(port, '0.0.0.0', () => console.log('Löyly sauna listening on port ' + port))
}
