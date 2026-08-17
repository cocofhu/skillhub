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
export const ARM_CONFIRM = 'fail-loud'

export interface RecoveryMountOptions {
  profile?: string
  profileDir?: string
  trustedHosts?: readonly string[] | (() => readonly string[])
  restart?: (result: { removed: string[]; kept: string[] }) => void
  /** Used when `restart` is omitted (production respawn + spawn-failure tests). */
  restartHooks?: RestartHooks
  overlaySource?: string
  /** Optional home-level cordis.patch.yml override for nuke reconcile. */
  homePatchPath?: string
  /** Test hook: pre-seed or inspect the fail-loud arm session. */
  session?: RecoverySession
  /**
   * Host-observable fail-loud signal (loader FAILED fibers, test stub).
   * GET /recovery.js issues a nonce only when this is true or session.failLoud is set.
   */
  failLoud?: () => boolean
}

export interface RecoverySession {
  /** One-time nonce issued only after a Host fail-loud signal. */
  nonce: string | null
  /** True only after fail-loud arm — never after a healthy GET of recovery.js. */
  armed: boolean
  /** Consumed after a successful nuke so the endpoint goes inert. */
  consumed: boolean
  /**
   * Fail-loud declared by Host loader or POST /recovery/arm (fail-page overlay).
   * Healthy boot leaves this false even if recovery.js is fetched.
   */
  failLoud: boolean
}

export function createRecoverySession(seed?: Partial<RecoverySession>): RecoverySession {
  return {
    nonce: seed?.nonce ?? null,
    armed: seed?.armed ?? false,
    consumed: seed?.consumed ?? false,
    failLoud: seed?.failLoud ?? false,
  }
}

/** Cordis FiberState.FAILED (numeric enum has no runtime object in some builds). */
export const FIBER_STATE_FAILED = 3

/** True only when the Host loader has an entry in Cordis FiberState.FAILED. */
export function loaderLooksFailLoud(loader?: {
  entries?: () => Iterable<{
    options?: { name?: string }
    fiber?: { state?: number } | null
  }>
} | null): boolean {
  if (!loader?.entries) return false
  try {
    for (const entry of loader.entries()) {
      const fiber = entry.fiber
      if (fiber?.state === FIBER_STATE_FAILED) return true
    }
  } catch {
    return false
  }
  return false
}

export function markRecoveryFailLoud(session: RecoverySession): void {
  session.failLoud = true
}

/** GET overlay may arm iff Host/test fail-loud is already observed. */
export function recoveryShouldArm(session: RecoverySession, options: RecoveryMountOptions = {}): boolean {
  if (session.consumed) return false
  if (session.failLoud) return true
  try {
    return options.failLoud?.() === true
  } catch {
    return false
  }
}

export function issueRecoveryNonce(session: RecoverySession, bytes: () => string = () => randomBytes(16).toString('hex')): string {
  const nonce = bytes()
  session.nonce = nonce
  session.armed = true
  session.consumed = false
  session.failLoud = true
  return nonce
}

/**
 * Healthy index does not fetch recovery.js. A tiny detector waits for the
 * fail-loud shell text, then loads overlay; script onerror shows CLI fallback.
 */
export function injectRecoveryScript(html: string, copy = FAIL_PAGE_COPY): string {
  if (html.includes('data-skillhub-recovery=')) return html
  const title = JSON.stringify(copy.title)
  const cli = JSON.stringify(copy.cliFallback)
  const snippet = `<script data-skillhub-recovery="1">(function(){var TITLE=${title};var CLI=${cli};function showCli(){if(document.getElementById("skillhub-recovery-cli"))return;var p=document.createElement("p");p.id="skillhub-recovery-cli";p.setAttribute("data-skillhub-recovery-ui","cli-fallback");p.textContent=CLI;if(document.body)document.body.appendChild(p);}function go(){var t=document.body&&document.body.innerText||"";if(t.indexOf(TITLE)===-1)return false;if(document.querySelector("script[data-skillhub-recovery-src]"))return true;var s=document.createElement("script");s.src=new URL("./skillhub/recovery.js",document.baseURI).href;s.defer=true;s.setAttribute("data-skillhub-recovery-src","1");s.onerror=showCli;document.head.appendChild(s);return true;}function watch(){if(go())return;var n=typeof MutationObserver==="function"?new MutationObserver(function(){if(go())n.disconnect();}):null;if(n&&document.body)n.observe(document.body,{childList:true,subtree:true,characterData:true});setTimeout(go,400);setTimeout(go,1200);}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",watch);else watch();})();</script>`
  if (html.includes('</head>')) return html.replace('</head>', `${snippet}</head>`)
  return snippet + html
}

export function overlayPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'overlay.js')
}

/** Embed fail-page-machine copy + one-time nonce so overlay stays in sync with TypeScript. */
export function materializeOverlay(source: string, nonce: string, copy = FAIL_PAGE_COPY, armed = Boolean(nonce)): string {
  const payload = JSON.stringify({
    button: copy.button,
    warningTitle: copy.warningTitle,
    warningBody: copy.warningBody,
    hint: copy.hint,
    running: copy.running,
    successTitle: copy.successTitle,
    successBody: copy.successBody,
    restartHint: copy.restartHint,
    cliFallback: copy.cliFallback,
    retry: '重试',
    nonce,
    armed,
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
  /** Called instead of process.exit after a successful spawn. */
  onExit?: () => void
  /** Delay before spawn. Default 0 (HTTP handler spawns before responding). */
  delayMs?: number
  /** Window to observe child `error` before treating spawn as success. */
  errorWindowMs?: number
}

type SpawnedChild = {
  unref?: () => void
  once?: (event: string, listener: (err: Error) => void) => unknown
}

function spawnDetached(hooks: RestartHooks): Promise<SpawnedChild> {
  if (hooks.run) {
    return Promise.resolve().then(() => {
      hooks.run!()
      return { unref() {} }
    })
  }
  const childSpawn = hooks.spawn ?? spawn
  const wait = hooks.wait ?? ((fn, ms) => { setTimeout(fn, ms) })
  const errorWindowMs = hooks.errorWindowMs ?? 80
  return new Promise((resolve, reject) => {
    let child: SpawnedChild
    try {
      child = childSpawn(hooks.execPath ?? process.execPath, hooks.argv ?? process.argv.slice(1), {
        detached: true,
        stdio: 'ignore',
        cwd: hooks.cwd ?? process.cwd(),
        env: { ...(hooks.env ?? process.env), SKILLHUB_RECOVERY_RESPAWN: '1' },
      }) as SpawnedChild
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    let settled = false
    const succeed = () => {
      if (settled) return
      settled = true
      child.unref?.()
      resolve(child)
    }
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
    }
    child.once?.('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
    wait(succeed, errorWindowMs)
  })
}

/**
 * Respawn the current dsh web process with the same argv (detached).
 * Resolves only after spawn succeeded (or the error window elapsed with no `error`).
 * On spawn failure: rejects and does not exit — caller can return 500 and retry.
 */
export function defaultRestart(hooks: RestartHooks = {}): Promise<void> {
  const wait = hooks.wait ?? ((fn, ms) => { setTimeout(fn, ms) })
  const delayMs = hooks.delayMs ?? 0
  return new Promise((resolve, reject) => {
    wait(() => {
      spawnDetached(hooks).then(() => {
        if (hooks.exitCurrent !== false) (hooks.onExit ?? (() => { process.exit(0) }))()
        resolve()
      }, reject)
    }, delayMs)
  })
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
  webServer.tapIndex?.(html => injectRecoveryScript(html))

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
      const armedNow = recoveryShouldArm(session, options)
      const nonce = armedNow ? issueRecoveryNonce(session) : ''
      const body = materializeOverlay(overlayTemplate, nonce, FAIL_PAGE_COPY, armedNow)
      res.statusCode = 200
      res.setHeader('content-type', 'text/javascript; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      if (nonce) res.setHeader('x-skillhub-recovery-nonce', nonce)
      res.end(req.method === 'HEAD' ? '' : body)
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/skillhub/recovery/arm',
    handler: async (req, res) => {
      try {
        assertRecoveryAllowed({
          method: req.method,
          headers: req.headers,
          socket: req.socket,
          trustedHosts: trustedList(options),
        })
        if (session.consumed) {
          send(res, 404, { ok: false, error: 'recovery nuke is only available after fail-loud overlay arm' })
          return
        }
        const body = await readJson(req)
        if (body.failLoud !== true && body.confirm !== ARM_CONFIRM) {
          send(res, 400, { ok: false, error: 'fail-loud confirm required' })
          return
        }
        markRecoveryFailLoud(session)
        const nonce = issueRecoveryNonce(session)
        send(res, 200, { ok: true, nonce, copy: FAIL_PAGE_COPY })
      } catch (err) {
        if (err instanceof RecoveryAuthError) {
          send(res, err.status, { ok: false, error: err.message })
          return
        }
        send(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
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
        // Healthy boot: GET recovery.js must not arm. POST is 404 until fail-loud.
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
        let respawned = false
        if (options.restart === undefined) {
          await defaultRestart({ ...(options.restartHooks ?? {}), exitCurrent: false })
          respawned = true
        } else {
          options.restart({ removed: result.removed, kept: result.kept })
        }
        session.consumed = true
        session.armed = false
        session.nonce = null
        session.failLoud = false
        const payload = {
          ok: true,
          profile: result.profile,
          removed: result.removed,
          kept: result.kept,
          logs: result.logs,
          restartRequired: true,
          copy: FAIL_PAGE_COPY,
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        if (respawned) {
          const onExit = options.restartHooks?.onExit ?? (() => { process.exit(0) })
          res.once('finish', () => { setTimeout(onExit, 80) })
        }
        res.end(JSON.stringify(payload))
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
