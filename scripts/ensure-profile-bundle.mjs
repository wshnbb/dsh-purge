import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { findInstallProfile, repairProfileInstall } from '../lib/profile-repair.js'

const profile = findInstallProfile([process.env.INIT_CWD, process.env.npm_config_local_prefix, process.cwd(), path.dirname(fileURLToPath(import.meta.url))])
if (profile) {
  const result = repairProfileInstall(profile, { registration: true })
  if (!result.ok) process.stderr.write('DSH plugin registration preserved; repair skipped: ' + result.skipped.join(', ') + '\n')
  else if (result.changed.length) process.stdout.write('DSH plugin registration repaired; backups saved beside changed files.\n')
}
