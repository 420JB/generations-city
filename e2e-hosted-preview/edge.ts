import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders } from 'node:http'
import { createServer, type Server } from 'node:https'
import { resolve } from 'node:path'

/**
 * A LOCAL STAND-IN FOR RAILWAY'S EDGE, for the hosted preview browser tests only: it terminates TLS for
 * https://localhost (a throwaway self-signed certificate, made here with openssl and never committed) and forwards each
 * request to the preview server on loopback, with X-Real-IP set to the client's own address, overwriting whatever the
 * client sent, as TRUSTED_PROXY=railway assumes the real edge does. Nothing else is changed: method, path, every other
 * header (Authorization, Cookie, Origin, X-Forwarded-For as the client wrote it) and the body pass through untouched.
 */
const CERT_DIR = resolve(import.meta.dirname, '../test-artifacts/hosted-preview-edge')

function certificate(): { key: Buffer; cert: Buffer } {
  const key = resolve(CERT_DIR, 'localhost.key')
  const cert = resolve(CERT_DIR, 'localhost.crt')
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(CERT_DIR, { recursive: true })
    const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '7', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' })
    if (made.status !== 0) throw new Error(`could not make the edge's test certificate: ${made.stderr}`)
  }
  return { key: readFileSync(key), cert: readFileSync(cert) }
}

export function startEdge(options: { port: number; upstreamPort: number }): Promise<Server> {
  const edge = createServer(certificate(), (req, res) => {
    const headers: IncomingHttpHeaders = { ...req.headers }
    delete headers['x-real-ip']
    headers['x-real-ip'] = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    const upstream = request({ host: '127.0.0.1', port: options.upstreamPort, method: req.method, path: req.url, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  })
  return new Promise((resolveListen) => edge.listen(options.port, '127.0.0.1', () => resolveListen(edge)))
}
