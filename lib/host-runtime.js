import path from 'node:path'
import { hostFs, readAsarJson } from './extract-asar.js'

/** Package identity is diagnostic evidence, not a declaration that patches work. */
export function inspectHostRuntime({ aiBase = '', desktopExe = '' } = {}) {
  const resources = desktopExe ? path.join(path.dirname(desktopExe), 'resources') : ''
  const archive = resources ? path.join(resources, 'app.asar') : ''
  let sealed = false
  try { sealed = Boolean(archive && hostFs.statSync(archive).isFile()) } catch { /* Not installed or being replaced. */ }
  const roots = [
    ...(sealed ? [] : resources ? [path.join(resources, 'app', 'dsh', 'package.json'), path.join(resources, 'app', 'package.json')] : []),
    ...(aiBase && !sealed ? [path.resolve(aiBase, '..', '..', 'package.json')] : []),
  ]
  for (const filename of roots) {
    try {
      const pkg = JSON.parse(hostFs.readFileSync(filename, 'utf8'))
      if (/^@deepseek-ai\/dsh(?:-desktop(?:-runtime)?)?$/.test(pkg.name) && typeof pkg.version === 'string') {
        return { version: pkg.version, package: pkg.name, source: filename, sealed }
      }
    } catch { /* Try the next official package location. */ }
  }
  if (sealed) {
    for (const filename of ['dsh/package.json', 'package.json']) {
      try {
        const pkg = readAsarJson(archive, filename)
        if (/^@deepseek-ai\/dsh(?:-desktop(?:-runtime)?)?$/.test(pkg.name) && typeof pkg.version === 'string') {
          return { version: pkg.version, package: pkg.name, source: archive + '/' + filename, sealed }
        }
      } catch { /* Remain unknown if the archive is incomplete or unreadable. */ }
    }
  }
  return { version: '', package: '', source: '', sealed }
}
