import fs from 'node:fs'
import path from 'node:path'

const owners = new WeakMap()
export function diagnosticsPath(dshHome) { return path.join(dshHome, 'dsh-purge', 'diagnostics', 'host.jsonl') }
export function diagnosticMessage(value) {
  return String(value || '').slice(0, 2000)
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|authorization|cookie)["']?)\s*[=:]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/\bsk-[a-z0-9_-]+/gi, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
}

export function installRuntimeDiagnostics({ dshHome, version, emitter = process, maxBytes = 1024 * 1024 } = {}) {
  if (!dshHome || typeof emitter?.on !== 'function') return () => {}
  let scopes = owners.get(emitter)
  if (!scopes) owners.set(emitter, scopes = new Map())
  const filename = diagnosticsPath(dshHome)
  let slot = scopes.get(filename)
  if (!slot) {
    const write = (event, details = {}) => {
      try {
        fs.mkdirSync(path.dirname(filename), { recursive: true })
        if (fs.existsSync(filename) && fs.statSync(filename).size >= maxBytes) fs.renameSync(filename, filename + '.1')
        fs.appendFileSync(filename, JSON.stringify({ at: new Date().toISOString(), pid: emitter.pid, event, version, ...details }) + '\n', 'utf8')
      } catch { /* Diagnostics must never change host success or failure. */ }
    }
    const exit = code => write('host-exit', { code })
    const exception = (error, origin) => write('host-exception', { origin, error: { name: error?.name, code: error?.code, message: diagnosticMessage(error?.message) } })
    emitter.on('exit', exit)
    emitter.on('uncaughtExceptionMonitor', exception)
    slot = { count: 0, write, exit, exception }
    scopes.set(filename, slot)
    write('plugin-start', { ppid: emitter.ppid, node: emitter.versions?.node })
  }
  slot.count++
  let active = true
  return () => {
    if (!active) return
    active = false
    if (--slot.count) return
    slot.write('plugin-stop')
    emitter.removeListener('exit', slot.exit)
    emitter.removeListener('uncaughtExceptionMonitor', slot.exception)
    scopes.delete(filename)
  }
}
