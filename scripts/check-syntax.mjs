import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') return []
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? files(target) : /\.(?:js|mjs|cjs)$/.test(entry.name) ? [target] : []
  })
}
const targets = files(root)
for (const file of targets) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(file + ': ' + (result.error?.message || result.stderr))
}
console.log(`Syntax checked ${targets.length} files.`)
