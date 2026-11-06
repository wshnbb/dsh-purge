import path from 'node:path'

// A session fact must not be inferred from the plugin host's process.cwd().
export function sessionWorkingDirectory(context) {
  const candidates = [context?.agent?.session?.header?.cwd, context?.session?.header?.cwd, context?.cwd]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const value = candidate.trim()
    if (!value || /[\x00-\x1f\x7f]/.test(value)) continue
    if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return value
  }
  return ''
}

export function assemblyWorkingDirectory(assembly, context) {
  const current = sessionWorkingDirectory(context)
  if (current) return { cwd: current, variables: { ...(assembly?.variables || {}), cwd: current } }
  return { cwd: '', variables: assembly?.variables }
}
