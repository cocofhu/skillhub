import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RecoveryAuthError,
  assertRecoveryAllowed,
  isLoopbackAddress,
  isLoopbackAuthority,
  isTrustedAuthority,
} from '../recovery/loopback-auth.js'

function req(partial: {
  method?: string
  remoteAddress?: string
  host?: string
  origin?: string
  referer?: string
  site?: string
  trustedHosts?: string[]
  headers?: Record<string, string | string[] | undefined>
}) {
  return {
    method: partial.method || 'POST',
    headers: {
      host: partial.host || '127.0.0.1:3080',
      origin: partial.origin,
      referer: partial.referer,
      'sec-fetch-site': partial.site,
      ...partial.headers,
    },
    socket: { remoteAddress: partial.remoteAddress || '127.0.0.1' },
    trustedHosts: partial.trustedHosts,
  }
}

test('loopback addresses are accepted, public ones are not', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.0.0.2'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('10.0.0.8'), false)
  assert.equal(isLoopbackAddress('8.8.8.8'), false)
})

test('127.attacker.example hostname is NOT loopback authority', () => {
  assert.equal(isLoopbackAuthority('127.attacker.example'), false)
  assert.equal(isLoopbackAuthority('127.attacker.example:3080'), false)
  assert.throws(
    () => assertRecoveryAllowed(req({ host: '127.attacker.example:3080' })),
    RecoveryAuthError,
  )
})

test('X-Forwarded-For cannot bypass non-loopback remoteAddress', () => {
  assert.throws(
    () => assertRecoveryAllowed(req({
      remoteAddress: '203.0.113.9',
      headers: { 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1' },
    })),
    (err: unknown) => err instanceof RecoveryAuthError && err.status === 403,
  )
})

test('L1 fixture: local POST is allowed', () => {
  assert.doesNotThrow(() => assertRecoveryAllowed(req({})))
})

test('L1 fixture: non-loopback remote is rejected', () => {
  assert.throws(
    () => assertRecoveryAllowed(req({ remoteAddress: '203.0.113.9' })),
    (err: unknown) => err instanceof RecoveryAuthError && err.status === 403,
  )
})

test('matching Origin/Referer on loopback is allowed', () => {
  assert.doesNotThrow(() => assertRecoveryAllowed(req({
    origin: 'http://127.0.0.1:3080',
    referer: 'http://127.0.0.1:3080/',
  })))
})

test('untrusted Host and cross-site markers are rejected', () => {
  assert.throws(() => assertRecoveryAllowed(req({ host: 'evil.example:3080' })), RecoveryAuthError)
  assert.throws(() => assertRecoveryAllowed(req({ site: 'cross-site' })), RecoveryAuthError)
  assert.throws(() => assertRecoveryAllowed(req({ origin: 'http://evil.example' })), RecoveryAuthError)
  assert.throws(() => assertRecoveryAllowed(req({ referer: 'http://evil.example/x' })), RecoveryAuthError)
  assert.throws(() => assertRecoveryAllowed(req({ method: 'GET' })), (err: unknown) => err instanceof RecoveryAuthError && err.status === 405)
})

test('empty and malformed authorities are rejected', () => {
  assert.equal(isLoopbackAddress(''), false)
  assert.equal(isLoopbackAddress(undefined), false)
  assert.equal(isTrustedAuthority('', []), false)
  assert.equal(isTrustedAuthority('not a host', []), false)
})

test('array Host headers and port-less trusted hosts work', () => {
  assert.doesNotThrow(() => assertRecoveryAllowed({
    method: 'POST',
    headers: { host: ['127.0.0.1:3080'] },
    socket: { remoteAddress: '127.0.0.1' },
  }))
  assert.doesNotThrow(() => assertRecoveryAllowed(req({
    host: 'preview.example:9443',
    trustedHosts: ['preview.example'],
  })))
  assert.doesNotThrow(() => assertRecoveryAllowed(req({
    host: 'preview.example:8443',
    origin: 'http://preview.example:8443',
    trustedHosts: ['preview.example:8443'],
  })))
})
