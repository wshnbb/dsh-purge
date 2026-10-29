import fs from 'node:fs'
import path from 'node:path'

export function validateEngagementId(value) {
  if (typeof value !== 'string') throw new Error('invalid engagement id')
  const id = value.trim()
  if (!id || id.length > 200 || id === '.' || id === '..'
    || /[\\/:*?"<>|\x00-\x1f]/.test(id) || /[. ]$/.test(id)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)) {
    throw new Error('invalid engagement id')
  }
  return id
}

function contains(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
}

// Resolve existing ancestors as well as the final file: a junction or symlink
// must not turn a lexically contained, not-yet-created file into an outside write.
function physicalPath(target) {
  let current = target
  const missing = []
  for (;;) {
    try {
      fs.lstatSync(current)
      return path.resolve(fs.realpathSync(current), ...missing.reverse())
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      // A dangling symlink must not be treated as a missing ordinary directory.
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('dangling link in protected path') }
      catch (statError) { if (statError.code !== 'ENOENT') throw statError }
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.push(path.basename(current))
      current = parent
    }
  }
}

export function assertContainedPath(target, root) {
  const absolute = path.resolve(target)
  const base = path.resolve(root)
  if (!contains(base, absolute) || !contains(physicalPath(base), physicalPath(absolute))) {
    throw new Error('path outside allowed root: ' + absolute)
  }
  return absolute
}
