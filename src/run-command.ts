import { spawn } from 'node:child_process'

export interface RunCommandOptions {
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}

/** Shared spawn helper for marketplace install and self-update. */
export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve(out)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(new Error(`命令超时 ${options.timeoutMs}ms`))
    }, options.timeoutMs)
    const onAbort = () => {
      child.kill('SIGTERM')
      finish(new Error('命令已取消'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { out += String(chunk) })
    child.on('error', (err) => finish(err))
    child.on('close', (code) => {
      if (code === 0) finish()
      else finish(new Error(`命令失败 (exit ${code}): ${out.trim().slice(-800) || 'no output'}`))
    })
  })
}
