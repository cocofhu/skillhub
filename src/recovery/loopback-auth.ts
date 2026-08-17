/** Privileged recovery endpoint may only be reached from the same machine. */
export class RecoveryAuthError extends Error {
  readonly status: number
  constructor(message: string, status = 403) {
    super(message)
    this.name = 'RecoveryAuthError'
    this.status = status
  }
}

export interface RecoveryTrustInput {
  method?: string
  headers: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string | null }
  trustedHosts?: readonly string[]
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function isLoopbackAddress(addr?: string | null): boolean {
  if (!addr) return false
  const value = addr.trim().toLowerCase()
  if (value === '::1' || value === '127.0.0.1') return true
  if (value.startsWith('::ffff:127.0.0.1')) return true
  if (value.startsWith('127.')) return true
  return false
}

export function parseAuthority(raw: string): { host: string; port: string } | undefined {
  const value = String(raw || '').trim().toLowerCase()
  if (!value) return undefined
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`)
    return { host: url.hostname, port: url.port }
  } catch {
    return undefined
  }
}

export function isLoopbackAuthority(hostHeader: string): boolean {
  const parsed = parseAuthority(hostHeader)
  if (!parsed) return false
  if (LOOPBACK_HOSTS.has(parsed.host)) return true
  if (parsed.host.startsWith('127.')) return true
  return false
}

export function isTrustedAuthority(hostHeader: string, trustedHosts: readonly string[] = []): boolean {
  if (isLoopbackAuthority(hostHeader)) return true
  const parsed = parseAuthority(hostHeader)
  if (!parsed) return false
  for (const entry of trustedHosts) {
    const trusted = parseAuthority(entry)
    if (!trusted) continue
    if (trusted.host !== parsed.host) continue
    if (!trusted.port || trusted.port === parsed.port) return true
  }
  return false
}

export function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const raw = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(raw)) return String(raw[0] || '')
  return String(raw || '')
}

export function originAuthority(originOrReferer: string): string {
  const parsed = parseAuthority(originOrReferer)
  if (!parsed) return ''
  return parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host
}

export function assertRecoveryAllowed(req: RecoveryTrustInput, options?: { methods?: readonly string[] }): void {
  const methods = options?.methods ?? ['POST']
  const method = String(req.method || 'GET').toUpperCase()
  if (!methods.includes(method)) {
    throw new RecoveryAuthError(`method ${method} not allowed`, 405)
  }
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    throw new RecoveryAuthError('recovery is loopback-only')
  }
  const host = headerValue(req.headers, 'host')
  const trusted = req.trustedHosts ?? []
  if (!isTrustedAuthority(host, trusted)) {
    throw new RecoveryAuthError('host is not a trusted local authority')
  }
  const site = headerValue(req.headers, 'sec-fetch-site').toLowerCase()
  if (site === 'cross-site') {
    throw new RecoveryAuthError('cross-site recovery is forbidden')
  }
  const origin = headerValue(req.headers, 'origin')
  if (origin && !sameTrustedOrigin(origin, host, trusted)) {
    throw new RecoveryAuthError('origin does not match host')
  }
  const referer = headerValue(req.headers, 'referer')
  if (referer && !sameTrustedOrigin(referer, host, trusted)) {
    throw new RecoveryAuthError('referer does not match host')
  }
}

function sameTrustedOrigin(from: string, host: string, trusted: readonly string[]): boolean {
  if (isTrustedAuthority(from, trusted)) return true
  const left = originAuthority(from)
  const right = originAuthority(host)
  return Boolean(left && right && left === right)
}
