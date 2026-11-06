import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { hostFs } from './extract-asar.js'

function temporaryPath(filename) {
  return `${filename}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
}

function targetMode(fs, filename) {
  try { return fs.statSync(filename).mode & 0o777 } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

// Existing file links retain their identity; replace their resolved file.
function writableTarget(fs, filename) {
  let link = false
  try {
    link = fs.lstatSync(filename).isSymbolicLink()
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (link) filename = fs.realpathSync(filename)
  return { filename, mode: targetMode(fs, filename) }
}

export function writeAtomicSync(filename, content, encoding = 'utf8', fs = hostFs) {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  const target = writableTarget(fs, filename)
  filename = target.filename
  const mode = target.mode, temporary = temporaryPath(filename)
  let fd
  try {
    fd = fs.openSync(temporary, 'wx', mode)
    fs.writeFileSync(fd, content, encoding)
    if (mode !== undefined) fs.fchmodSync(fd, mode)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temporary, filename)
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
    try { fs.unlinkSync(temporary) } catch {}
    throw error
  }
}

export async function writeAtomic(filename, content, encoding = 'utf8', fs = hostFs) {
  await fs.promises.mkdir(path.dirname(filename), { recursive: true })
  const target = writableTarget(fs, filename)
  filename = target.filename
  const mode = target.mode, temporary = temporaryPath(filename)
  try {
    // Use the supported hostFs promise API; it deliberately has no open().
    await fs.promises.writeFile(temporary, content, { encoding, flag: 'wx', ...(mode !== undefined ? { mode } : {}) })
    let fd
    try {
      fd = fs.openSync(temporary, 'r+')
      if (mode !== undefined) fs.fchmodSync(fd, mode)
      fs.fsyncSync(fd)
    } finally { if (fd !== undefined) fs.closeSync(fd) }
    await fs.promises.rename(temporary, filename)
  } catch (error) {
    try { await fs.promises.unlink(temporary) } catch {}
    throw error
  }
}
