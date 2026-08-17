import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome } from '../config-store.js'
import { applyNukeThirdParty } from './nuke-third-party.js'
import { RecoveryAuthError, assertRecoveryAllowed } from './loopback-auth.js'
import { FAIL_PAGE_COPY } from './fail-page-machine.js'

export const NUKE_CONFIRM = 'nuke-third-party'

export interface RecoveryMountOptions {
  profile?: string
  profileDir?: string
  trustedHosts?: readonly string[] | (() => readonly string[])
  restart?: (result: { removed: string[]; kept: string[] }) => void
  overlaySource?: string
}

export function injectRecoveryScript(html: string): string {
  if (html.includes('data-skillhub-recovery=')) return html
  const snippet = '<script data-skillhub-recovery="1">(function(){var s=document.createElement("script");s.src=new URL("./skillhub/recovery.js",document.baseURI).href;s.defer=true;document.head.appendChild(s);})();</script>'
  if (html.includes('</head>')) return html.replace('</head>', `${snippet}</head>`)
  return snippet + html
}

export function overlayPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'overlay.js')
}

function send(res: ServerResponse, code: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  res.statusCode = code
  res.setHeader('content-type', type)
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

function trustedList(options: RecoveryMountOptions): readonly string[] {
  const value = options.trustedHosts
  if (typeof value === 'function') return value()
  return value ?? []
}

function resolveProfileDir(options: RecoveryMountOptions): { profile: string; dir: string } {
  const profile = options.profile || process.env.DSH_PROFILE || 'web'
  const dir = options.profileDir || process.env.DSH_PROFILE_DIR || join(dshHome(), 'profiles', profile)
  return { profile, dir }
}

export function defaultRestart(hooks: { run?: () => void; wait?: (fn: () => void, ms: number) => void } = {}): void {
  const run = hooks.run ?? (() => { process.exit(0) })
  const wait = hooks.wait ?? ((fn, ms) => { setTimeout(fn, ms) })
  wait(run, 1500)
}

export function mountRecovery(
  webServer: {
    register: (route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => unknown
    tapIndex?: (transform: (html: string) => string) => unknown
  },
  options: RecoveryMountOptions = {},
): void {
  const overlay = options.overlaySource ?? readFileSync(overlayPath(), 'utf8')
  webServer.tapIndex?.(injectRecoveryScript)
  webServer.register({
    kind: 'exact',
    path: '/skillhub/recovery.js',
    handler: (req, res) => {
      try {
        assertRecoveryAllowed({
          method: req.method,
          headers: req.headers,
          socket: req.socket,
          trustedHosts: trustedList(options),
        }, { methods: ['GET', 'HEAD'] })
      } catch (err) {
        const auth = err instanceof RecoveryAuthError ? err : new RecoveryAuthError(String(err))
        send(res, auth.status, auth.message, 'text/plain; charset=utf-8')
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'text/javascript; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(req.method === 'HEAD' ? '' : overlay)
    },
  })
  webServer.register({
    kind: 'exact',
    path: '/skillhub/recovery/nuke',
    handler: async (req, res) => {
      try {
        assertRecoveryAllowed({
          method: req.method,
          headers: req.headers,
          socket: req.socket,
          trustedHosts: trustedList(options),
        })
        const body = await readJson(req)
        if (body.confirm !== NUKE_CONFIRM) {
          send(res, 400, { ok: false, error: 'confirm 必须为 nuke-third-party' })
          return
        }
        const { profile, dir } = resolveProfileDir(options)
        const result = applyNukeThirdParty(dir, profile)
        send(res, 200, {
          ok: true,
          profile: result.profile,
          removed: result.removed,
          kept: result.kept,
          logs: result.logs,
          restartRequired: true,
          copy: FAIL_PAGE_COPY,
        })
        if (options.restart === undefined) defaultRestart()
        else options.restart({ removed: result.removed, kept: result.kept })
      } catch (err) {
        if (err instanceof RecoveryAuthError) {
          send(res, err.status, { ok: false, error: err.message })
          return
        }
        send(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  })
}
