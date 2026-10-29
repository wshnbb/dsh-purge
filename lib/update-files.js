import fs from 'node:fs'
import path from 'node:path'

export function packageEntries(pkg) {
  if (pkg?.name !== 'dsh-purge' || !pkg.version || !Array.isArray(pkg.files)) {
    throw new Error('invalid dsh-purge package manifest')
  }
  const names = new Set(['package.json'])
  for (const entry of pkg.files) {
    if (typeof entry !== 'string' || entry.startsWith('!')) continue
    const name = entry.split('/')[0]
    if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..' || name.startsWith('.') || name === 'node_modules') {
      throw new Error('unsafe package entry')
    }
    names.add(name)
  }
  for (const required of ['lib', 'client.js']) {
    if (!names.has(required)) throw new Error('missing package entry: ' + required)
  }
  return [...names]
}

/** Prepare every destination first, then switch managed entries by rename.
 * Backups remain beside each install for recovery even if a later host patch fails.
 * io is injectable for deterministic disk/rename fault regression tests. */
export async function deployPackage(source, destinations, { io = fs.promises } = {}) {
  const pkg = JSON.parse(await io.readFile(path.join(source, 'package.json'), 'utf8'))
  const names = packageEntries(pkg)
  for (const required of ['lib/index.js', 'client.js']) await io.access(path.join(source, required))
  const transactions = []
  const changes = []
  try {
    for (const target of [...new Set(destinations.map(dir => path.resolve(dir)))]) {
      const directory = await io.mkdtemp(path.join(path.dirname(target), '.dsh-purge-update-'))
      const transaction = { target, directory, stage: path.join(directory, 'stage'), backup: path.join(directory, 'backup') }
      transactions.push(transaction)
      await io.mkdir(transaction.stage)
      await io.mkdir(transaction.backup)
      for (const name of names) {
        await io.cp(path.join(source, name), path.join(transaction.stage, name), { recursive: true, dereference: false })
      }
      await io.writeFile(path.join(directory, 'transaction.json'), JSON.stringify({ target, names, state: 'prepared' }, null, 2))
    }
    for (const transaction of transactions) {
      for (const name of names) {
        const change = { target: path.join(transaction.target, name), backup: path.join(transaction.backup, name), saved: false, installed: false }
        changes.push(change)
        try { await io.rename(change.target, change.backup); change.saved = true }
        catch (error) { if (error.code !== 'ENOENT') throw error }
        await io.rename(path.join(transaction.stage, name), change.target)
        change.installed = true
      }
      await io.writeFile(path.join(transaction.directory, 'transaction.json'), JSON.stringify({ target: transaction.target, names, state: 'installed' }, null, 2))
    }
  } catch (error) {
    const failures = []
    for (const change of changes.reverse()) {
      try {
        if (change.installed) await io.rm(change.target, { recursive: true, force: true })
        if (change.saved) await io.rename(change.backup, change.target)
      } catch (rollbackError) { failures.push(rollbackError.message) }
    }
    if (failures.length) {
      throw new Error('更新失败，部分文件需从备份恢复：' + transactions.map(t => t.directory).join(', '), { cause: new AggregateError([error, ...failures.map(message => new Error(message))]) })
    }
    for (const transaction of transactions) await io.rm(transaction.directory, { recursive: true, force: true }).catch(() => {})
    throw new Error('更新失败，原文件已保留或恢复：' + error.message, { cause: error })
  }
  for (const transaction of transactions) await io.rm(transaction.stage, { recursive: true, force: true }).catch(() => {})
  return { backups: transactions.map(t => ({ target: t.target, directory: t.directory })) }
}
