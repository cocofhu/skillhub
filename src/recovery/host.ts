import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
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
  /** Optional home-level cordis.patch.yml override for nuke reconcile. */
  homePatchPath?: string
  /** Test hook: pre-seed or inspect the fail-loud arm session. */
  session?: RecoverySession
}

export interface RecoverySession {
  /** One-time nonce issued when overlay is served (fail-loud path). */
  nonce: string | null
  /** Set true only after overlay GET — healthy UI without overlay fetch → nuke 404. */
  armed: boolean
  /** Consumed after a successful nuke so the endpoint goes inert. */
  consumed: boolean
}

export function createRecoverySession(seed?: Partial<RecoverySession>): RecoverySession {
  return {
    nonce: seed?.nonce ?? null,
    armed: seed?.armed ?? false,
    consumed: seed?.consumed ?? false,
  }
}

export function issueRecoveryNonce(session: RecoverySession, bytes: () => string = () => randomBytes(16).toString('hex')): string {
  const nonce = bytes()
  session.nonce = nonce
  session.armed = true
  session.consumed = false
  return nonce
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

/** Embed fail-page-machine copy + one-time nonce so overlay stays in sync with TypeScript. */
export function materializeOverlay(source: string, nonce: string, copy = FAIL_PAGE_COPY): string {
  const payload = JSON.stringify({
    button: copy.button,
    warningTitle: copy.warningTitle,
    warningBody: copy.warningBody,
    hint: copy.hint,
    running: copy.running,
    successTitle: copy.successTitle,
    successBody: copy.successBody,
    restartHint: copy.restartHint,
    retry: '重试',
    nonce,
  })
  // Always prepend — do not string-replace inside overlay.js (it references the same global name).
  return `window.__SKILLHUB_RECOVERY_BOOT__=${payload};\n${source}`
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

export interface RestartHooks {
  run?: () => void
  wait?: (fn: () => void, ms: number) => void
  spawn?: typeof spawn
  execPath?: string
  argv?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** When false, only respawn and do not exit (tests). Default true. */
  exitCurrent?: boolean
}

/**
 * Respawn the current dsh web process with the same argv (detached), then exit.
 * Never treat bare process.exit as "restart".
 */
export function defaultRestart(hooks: RestartHooks = {}): void {
  const wait = hooks.wait ?? ((fn, ms) => { setTimeout(fn, ms) })
  const run = hooks.run ?? (() => {
    const childSpawn = hooks.spawn ?? spawn
    const execPath = hooks.execPath ?? process.execPath
    const argv = hooks.argv ?? process.argv.slice(1)
    const cwd = hooks.cwd ?? process.cwd()
    const env = hooks.env ?? process.env
    const child = childSpawn(execPath, argv, {
      detached: true,
      stdio: 'ignore',
      cwd,
      env: { ...env, SKILLHUB_RECOVERY_RESPAWN: '1' },
    })
    child.unref()
    if (hooks.exitCurrent === false) return
    process.exit(0)
  })
  wait(run, 800)
}

export function mountRecovery(
  webServer: {
    register: (route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => unknown
    tapIndex?: (transform: (html: string) => string) => unknown
  },
  options: RecoveryMountOptions = {},
): RecoverySession {
  const session = options.session ?? createRecoverySession()
  const overlayTemplate = options.overlaySource ?? readFileSync(overlayPath(), 'utf8')
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
      const nonce = issueRecoveryNonce(session)
      const body = materializeOverlay(overlayTemplate, nonce)
      res.statusCode = 200
      res.setHeader('content-type', 'text/javascript; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('x-skillhub-recovery-nonce', nonce)
      res.end(req.method === 'HEAD' ? '' : body)
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
        // Healthy boot / never fetched overlay → endpoint inert (404), not a static confirm door.
        if (!session.armed || session.consumed || !session.nonce) {
          send(res, 404, { ok: false, error: 'recovery nuke is only available after fail-loud overlay arm' })
          return
        }
        const body = await readJson(req)
        if (body.confirm !== NUKE_CONFIRM) {
          send(res, 400, { ok: false, error: 'confirm 必须为 nuke-third-party' })
          return
        }
        if (body.nonce !== session.nonce) {
          send(res, 400, { ok: false, error: 'nonce 无效或已过期' })
          return
        }
        const { profile, dir } = resolveProfileDir(options)
        const homePatchPath = options.homePatchPath
          ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'cordis.patch.yml') : undefined)
        const result = applyNukeThirdParty(dir, profile, { homePatchPath })
        session.consumed = true
        session.armed = false
        session.nonce = null
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

  return session
}
