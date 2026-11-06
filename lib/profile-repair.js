// Adapted maintenance behavior from HunYiSage/dsh-purge 1.1.92 (#180/#191/#209).
// Preserve the custom bundle's own main insert and explicit user disable choices.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { writeAtomicSync } from './atomic-file.js'
import { assertContainedPath } from './safe-path.js'

const PACKAGE = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
export const PLUGIN_NAME = PACKAGE.name
const DEFAULT_INSERT = `- insert:\n    - id: ${PLUGIN_NAME}\n      name: ${PLUGIN_NAME}\n      inject: [systemPrompt, tools]\n`
function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}
function scalar(value) { return String(value).trim().replace(/^(['"])(.*)\1$/, '$2') }

export function hasBodyInsert(raw) {
  let indent = -1
  for (const line of String(raw).split(/\r?\n/)) {
    const leading = line.search(/\S/), text = line.trim()
    if (!text || text.startsWith('#')) continue
    if (/^-\s*insert:\s*(?:#.*)?$/.test(text)) { indent = leading; continue }
    if (indent < 0) continue
    if (leading <= indent) { indent = -1; continue }
    const match = text.match(/^(?:-\s*)?(?:name|id):\s*(.*?)\s*(?:#.*)?$/)
    if (match && [PLUGIN_NAME, 'dsh-purge-main'].includes(scalar(match[1]))) return true
  }
  return false
}

export function appendBodyInsert(raw, block = DEFAULT_INSERT) {
  const text = String(raw)
  if (hasBodyInsert(text)) return text
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const data = lines.map((line, index) => ({ text: line.trim(), index })).filter(row => row.text && !row.text.startsWith('#'))
  const markers = data.filter(row => row.text === '---')
  if (markers.length > 1 || (markers.length && markers[0] !== data[0]) || data.some(row => row.text === '...')) return null
  const body = data.filter(row => row.text !== '---')
  if (body.length === 1 && /^\[\s*\]\s*(?:#.*)?$/.test(body[0].text)) {
    const comment = body[0].text.match(/#.*$/)?.[0]
    lines[body[0].index] = (comment ? comment + '\n' : '') + block.trimEnd()
    return lines.join('\n').replace(/\n*$/, '\n')
  }
  if (body.length && !/^-(?:\s|$)/.test(body[0].text)) return null
  return text + (text && !text.endsWith('\n') ? '\n' : '') + block
}

export function parseBuildLine(line) {
  const match = String(line).match(/^\s+(?:"((?:\\.|[^"])*)"|'((?:''|[^'])*)'|([^#][\s\S]*?)):\s*(true|false)(\s*(?:#.*)?)$/)
  if (!match) return null
  let key
  if (match[1] !== undefined) {
    try { key = JSON.parse('"' + match[1] + '"') } catch { return null }
  } else key = match[2] !== undefined ? match[2].replace(/''/g, "'") : match[3].trim()
  return { key, value: match[4] === 'true', comment: match[5] }
}

export function rewriteAllowBuilds(raw, { major = null, name = PLUGIN_NAME } = {}) {
  const text = String(raw), eol = text.includes('\r\n') ? '\r\n' : '\n', lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => /^allowBuilds\s*:/.test(line))
  if (start < 0) return text + (text && !text.endsWith('\n') ? eol : '') + `allowBuilds:${eol}  ${name}: true${eol}`
  if (!/^allowBuilds\s*:\s*(?:#.*)?$/.test(lines[start])) return null
  let end = start + 1
  while (end < lines.length && (!lines[end].trim() || /^\s|^#/.test(lines[end]))) end++
  const kept = [], owned = [], sourceKeys = new Set()
  for (const line of lines.slice(start + 1, end)) {
    const entry = parseBuildLine(line)
    if (!entry || !(entry.key === name || entry.key.startsWith(name + '@'))) { kept.push(line); continue }
    owned.push(entry)
    if ((major === null || major >= 12) && entry.key.startsWith(name + '@') && /@(?:git\+)?https:\/\//.test(entry.key)) {
      if (!sourceKeys.has(entry.key)) kept.push(line)
      sourceKeys.add(entry.key)
    }
  }
  const bare = owned.filter(entry => entry.key === name)
  if (bare.length === 1 && new Set(owned.map(entry => entry.key)).size === owned.length
    && owned.every(entry => entry.key === name || ((major === null || major >= 12) && /@(?:git\+)?https:\/\//.test(entry.key)))) return text
  const value = !(bare.length ? bare : owned).some(entry => entry.value === false)
  const comment = bare.at(-1)?.comment || ''
  const last = kept.findLastIndex(line => line.trim()) + 1
  kept.splice(last, 0, `  ${name}: ${value}${comment}`)
  const next = [...lines.slice(0, start + 1), ...kept, ...lines.slice(end)].join(eol)
  return next === text ? text : next.replace(/(?:\r?\n)*$/, eol)
}

function yamlFor(profileDir) {
  try { return createRequire(path.join(profileDir, 'package.json'))('yaml') } catch { return null }
}
function parseYaml(yaml, text, strict = true) {
  const doc = yaml.parseDocument(text || '', { uniqueKeys: strict, customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
  if (doc.errors.length) throw new Error('invalid YAML')
  return doc.toJS({ maxAliasCount: 50 })
}
function majorVersion(profileDir, pkg) {
  const spec = pkg.packageManager || ''
  let match = String(spec).match(/^pnpm@(\d+)/)
  if (match) return Number(match[1])
  try { match = fs.readFileSync(path.join(profileDir, 'node_modules/.modules.yaml'), 'utf8').match(/packageManager:\s*pnpm@(\d+)/) } catch {}
  return match ? Number(match[1]) : null
}
function declarationName(entry) { return typeof entry === 'string' ? entry : entry?.name || entry?.id }

/** Restrict repairs to an existing profile that directly owns this plugin. */
export function repairProfileInstall(profileDir, { registration = false, yaml = yamlFor(profileDir), bundleText, atomicWrite = writeAtomicSync } = {}) {
  const manifestPath = path.join(profileDir, 'package.json'), pkg = readJson(manifestPath)
  const result = { ok: true, profileDir, changed: [], skipped: [] }
  if (!pkg?.name?.startsWith('dsh-profile-') || !Object.hasOwn(pkg.dependencies || {}, PLUGIN_NAME)) return { ...result, skipped: ['not-owner-profile'] }
  if (!yaml?.parseDocument) return { ...result, ok: false, skipped: ['yaml-unavailable'] }
  const metadata = pkg.dsh?.profile
  if ((pkg.dsh != null && (typeof pkg.dsh !== 'object' || Array.isArray(pkg.dsh)))
    || (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata)))
    || (metadata?.bundles != null && !Array.isArray(metadata.bundles))
    || (metadata?.plugins != null && !Array.isArray(metadata.plugins))) return { ...result, ok: false, skipped: ['invalid-profile-metadata'] }
  const pending = []
  const write = (filename, text) => {
    assertContainedPath(filename, profileDir)
    const previous = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : ''
    if (text === previous) return
    pending.push({ filename, text, previous, existed: fs.existsSync(filename) })
  }
  // Validate both YAML inputs before changing any registration.
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  const patch = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : ''
  const workspacePath = path.join(profileDir, 'pnpm-workspace.yaml')
  const workspace = fs.existsSync(workspacePath) ? fs.readFileSync(workspacePath, 'utf8') : ''
  let workspaceData, patchData
  try {
    patchData = parseYaml(yaml, patch)
    workspaceData = parseYaml(yaml, workspace, false)
    if (patchData != null && !Array.isArray(patchData)) throw new Error('patch is not a sequence')
    if (workspaceData != null && (typeof workspaceData !== 'object' || Array.isArray(workspaceData))) throw new Error('workspace is not a mapping')
  } catch { return { ...result, ok: false, skipped: ['unrecognized-config'] } }
  const nextWorkspace = rewriteAllowBuilds(workspace, { major: majorVersion(profileDir, pkg) })
  try {
    if (nextWorkspace === null) throw new Error('unsupported build configuration')
    const next = parseYaml(yaml, nextWorkspace)
    const others = value => Object.fromEntries(Object.entries(value || {}).filter(([key]) => key !== 'allowBuilds'))
    if (JSON.stringify(others(next)) !== JSON.stringify(others(workspaceData))) throw new Error('unrelated workspace setting changed')
    const unrelated = value => Object.fromEntries(Object.entries(value?.allowBuilds || {}).filter(([key]) => key !== PLUGIN_NAME && !key.startsWith(PLUGIN_NAME + '@')))
    if (JSON.stringify(unrelated(next)) !== JSON.stringify(unrelated(workspaceData))) throw new Error('unrelated build choice changed')
  } catch { return { ...result, ok: false, skipped: ['unsupported-build-config'] } }
  const bundles = pkg.dsh?.profile?.bundles
  const plugins = pkg.dsh?.profile?.plugins
  if (registration && !(bundles || []).some(entry => declarationName(entry) === PLUGIN_NAME)) {
    if ((plugins || []).some(entry => declarationName(entry) === PLUGIN_NAME) || hasBodyInsert(patch)) result.skipped.push('explicit-plugin-registration')
    else {
      if (bundles !== undefined && !Array.isArray(bundles)) return { ...result, ok: false, skipped: ['invalid-bundles'] }
      pkg.dsh ||= {}; pkg.dsh.profile ||= {}; pkg.dsh.profile.bundles = [...(bundles || []), PLUGIN_NAME]
      const bundled = bundleText ?? fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
      // This fork already inserts its main plugin from the bundle overlay.
      if (!hasBodyInsert(bundled)) {
        const nextPatch = appendBodyInsert(patch)
        if (nextPatch === null) return { ...result, ok: false, skipped: ['unsupported-patch-shape'] }
        try { if (!Array.isArray(parseYaml(yaml, nextPatch))) throw new Error() } catch { return { ...result, ok: false, skipped: ['invalid-new-patch'] } }
        write(patchPath, nextPatch)
      }
      write(manifestPath, JSON.stringify(pkg, null, 2) + '\n')
    }
  }
  write(workspacePath, nextWorkspace)
  const committed = []
  try {
    for (const item of pending) {
      const current = fs.existsSync(item.filename) ? fs.readFileSync(item.filename, 'utf8') : ''
      if (current !== item.previous) throw new Error('configuration changed during repair')
      const backup = `${item.filename}.purge-repair-${Date.now()}.bak`
      if (item.existed) atomicWrite(backup, item.previous)
      atomicWrite(item.filename, item.text)
      committed.push(item)
      result.changed.push({ path: item.filename, backup: item.existed ? backup : null })
    }
  } catch (error) {
    const recovery = []
    for (const item of committed.reverse()) {
      try {
        if (fs.readFileSync(item.filename, 'utf8') !== item.text) throw new Error('concurrent edit retained')
        if (item.existed) writeAtomicSync(item.filename, item.previous)
        else fs.unlinkSync(item.filename)
      } catch { recovery.push(item.filename) }
    }
    return { ...result, ok: false, error: error.message, rolledBack: recovery.length === 0, recovery }
  }
  return result
}

export function findInstallProfile(seeds) {
  for (const seed of seeds.filter(Boolean)) {
    let current = path.resolve(seed)
    for (let depth = 0; depth < 12; depth++) {
      const pkg = readJson(path.join(current, 'package.json'))
      if (pkg?.name?.startsWith('dsh-profile-') && Object.hasOwn(pkg.dependencies || {}, PLUGIN_NAME)) return current
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return ''
}
