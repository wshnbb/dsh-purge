import path from 'node:path'
import { execFileSync } from 'node:child_process'

export function selectWindowsDesktopPids(rows, exe) {
  if (!exe || !path.win32.isAbsolute(exe)) throw new Error('desktop executable path is required')
  const target = path.win32.normalize(exe).toLowerCase()
  return [...new Set((Array.isArray(rows) ? rows : [rows]).filter(row =>
    typeof row?.ExecutablePath === 'string'
    && path.win32.normalize(row.ExecutablePath).toLowerCase() === target
    && Number.isSafeInteger(Number(row.ProcessId)) && Number(row.ProcessId) > 0
  ).map(row => Number(row.ProcessId)))]
}

export function windowsDesktopPids(exe, run = execFileSync) {
  if (!exe || !path.win32.isAbsolute(exe)) throw new Error('desktop executable path is required')
  const script = "$ErrorActionPreference='Stop'; $OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -eq $env:DSH_PURGE_TARGET_EXE } | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"
  const raw = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 8000,
    env: { ...process.env, DSH_PURGE_TARGET_EXE: exe },
  })
  return selectWindowsDesktopPids(JSON.parse(String(raw).trim() || '[]'), exe)
}

export function windowsDesktopProcesses(exe, run = execFileSync) {
  if (!exe || !path.win32.isAbsolute(exe)) throw new Error('desktop executable path is required')
  const script = "$ErrorActionPreference='Stop'; $OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:DSH_PURGE_TARGET_EXE } | Select-Object ProcessId,ExecutablePath,CommandLine,@{Name='StartedAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress"
  const raw = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 8000, env: { ...process.env, DSH_PURGE_TARGET_EXE: exe },
  })
  const parsed = JSON.parse(String(raw).trim() || '[]'), rows = Array.isArray(parsed) ? parsed : [parsed]
  const ids = new Set(selectWindowsDesktopPids(rows, exe))
  return rows.filter(row => ids.has(Number(row.ProcessId)) && typeof row.StartedAt === 'string' && row.StartedAt)
    .map(row => ({ pid: Number(row.ProcessId), startedAt: row.StartedAt, commandLine: String(row.CommandLine || '') }))
}

/** Terminate only the original, still-matching processes, with main first. */
export function stopWindowsDesktopTargets(exe, targets, { query = windowsDesktopProcesses, kill = pid => process.kill(pid), selfPid = process.pid } = {}) {
  const ordered = targets.slice().sort((a, b) => Number(/(?:^|\s)--type(?:=|\s)/.test(a.commandLine)) - Number(/(?:^|\s)--type(?:=|\s)/.test(b.commandLine)))
  const stopped = []
  for (const target of ordered) {
    if (target.pid === selfPid) continue
    const current = query(exe).find(row => row.pid === target.pid && row.startedAt === target.startedAt)
    if (!current) continue
    try { kill(target.pid); stopped.push(target.pid) } catch { /* Already gone or inaccessible. */ }
  }
  return stopped
}
