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
  const script = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -eq $env:DSH_PURGE_TARGET_EXE } | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"
  const raw = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 8000,
    env: { ...process.env, DSH_PURGE_TARGET_EXE: exe },
  })
  return selectWindowsDesktopPids(JSON.parse(String(raw).trim() || '[]'), exe)
}
