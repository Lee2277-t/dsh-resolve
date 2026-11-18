import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { run } from './util.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(HERE, '..', 'bridge', 'bridge.py')

/** Default install locations, for the usual "next → next → finish" install. */
const EXE_CANDIDATES = [
  'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\Resolve.exe',
  'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve Studio\\Resolve.exe',
  'D:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\Resolve.exe',
  'D:\\Program Files\\Blackmagic Design\\DaVinci Resolve Studio\\Resolve.exe',
]

export const SUPPORT_DIR = 'C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support'
export const SCRIPT_API = path.join(SUPPORT_DIR, 'Developer', 'Scripting')

let systemExe = null
let systemExeTried = false

/**
 * Ask Windows where Resolve actually lives: the running process is authoritative,
 * then the uninstall registry (which is what a custom install directory leaves
 * behind). Cached for the life of the process.
 */
async function exeFromSystem() {
  if (systemExeTried) return systemExe
  systemExeTried = true
  const script = [
    // 1. A running Resolve is authoritative.
    "$p = Get-Process Resolve -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1",
    'if ($p) { $p.Path; exit 0 }',
    // 2. Whatever the uninstall entry recorded (custom install directories).
    "$keys = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "          'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "          'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    'foreach ($key in $keys) {',
    "  $entry = Get-ItemProperty $key -ErrorAction SilentlyContinue |",
    "    Where-Object { $_.DisplayName -match 'DaVinci Resolve' } | Select-Object -First 1",
    '  if (-not $entry) { continue }',
    "  foreach ($candidate in @($entry.DisplayIcon, $entry.InstallLocation)) {",
    '    if (-not $candidate) { continue }',
    '    $exe = $candidate.Trim(\'"\').Split(",")[0]',
    "    if ($exe -match 'Resolve\\.exe$' -and (Test-Path $exe)) { $exe; exit 0 }",
    "    $joined = Join-Path $exe 'Resolve.exe'",
    '    if (Test-Path $joined) { $joined; exit 0 }',
    '  }',
    '}',
    // 3. Bounded scan of the likely roots, for installs the registry never recorded.
    "foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, 'C:\\', 'D:\\', 'E:\\', 'F:\\')) {",
    '  if (-not $root -or -not (Test-Path $root)) { continue }',
    "  $dirs = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |",
    "    Where-Object { $_.Name -match 'resolve|davinci|blackmagic' }",
    '  foreach ($dir in $dirs) {',
    '    $exe = Join-Path $dir.FullName "Resolve.exe"',
    '    if (Test-Path $exe) { $exe; exit 0 }',
    "    $nested = Get-ChildItem $dir.FullName -Directory -ErrorAction SilentlyContinue |",
    "      Where-Object { $_.Name -match 'resolve' }",
    '    foreach ($child in $nested) {',
    '      $exe = Join-Path $child.FullName "Resolve.exe"',
    '      if (Test-Path $exe) { $exe; exit 0 }',
    '    }',
    '  }',
    '}',
  ].join('\n')
  try {
    const { stdout } = await run(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 20_000 },
    )
    const line = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)[0]
    if (line && existsSync(line)) systemExe = line
  } catch {
    // No Resolve, no PowerShell, or a locked-down policy: fall back to candidates.
  }
  return systemExe
}

async function findExe(explicit) {
  if (explicit && existsSync(explicit)) return explicit
  if (process.env.RESOLVE_EXE && existsSync(process.env.RESOLVE_EXE)) return process.env.RESOLVE_EXE
  for (const candidate of EXE_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  if (process.platform !== 'win32') return null
  return exeFromSystem()
}

export function tcpOpen(port, host = '127.0.0.1', timeout = 900) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, host)
  })
}

async function readVersionInfo(exePath) {
  if (!exePath || process.platform !== 'win32') return null
  try {
    const escaped = exePath.replace(/'/g, "''")
    const { stdout } = await run(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Get-Item '${escaped}').VersionInfo | Select-Object ProductName,FileVersion,ProductVersion | ConvertTo-Json -Compress`,
      ],
      { timeout: 20_000 },
    )
    const cleaned = stdout.trim().split(/\r?\n/).filter(Boolean).pop()
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

async function isResolveRunning() {
  if (process.platform !== 'win32') return false
  try {
    const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq Resolve.exe', '/NH'], { timeout: 10_000 })
    return /Resolve\.exe/i.test(stdout)
  } catch {
    return false
  }
}

/**
 * Inspect the local Resolve install: where it is, which edition, and whether the
 * external scripting port answers. The edition decides which backend can work.
 */
export async function detect(options = {}) {
  const exePath = await findExe(options.resolveExe)
  const versionInfo = await readVersionInfo(exePath)
  const productName = versionInfo?.ProductName ?? (exePath ? path.basename(path.dirname(exePath)) : null)
  const studio = /studio/i.test(productName ?? '')
  const scriptingPortOpen = await tcpOpen(1144)
  const running = await isResolveRunning()

  const resolvePython = exePath ? path.join(path.dirname(exePath), 'ResolvePython', 'ResolvePython.exe') : null
  const fusionscript = exePath ? path.join(path.dirname(exePath), 'fusionscript.dll') : null

  const backend = scriptingPortOpen && studio ? 'api' : 'file'

  const notes = []
  if (!exePath) notes.push('找不到 Resolve.exe：请用 config.resolveExe 或环境变量 RESOLVE_EXE 指定安装路径。')
  if (process.platform !== 'win32') {
    notes.push('这个插件的直连后端只支持 Windows 上的 Resolve；其它平台只能用 file 后端生成 .fcpxml。')
  }
  if (!studio && exePath) notes.push('这是免费版：没有外部脚本 API，插件会用「生成可导入成片」后端工作。')
  if (studio && !scriptingPortOpen) {
    notes.push(
      'Studio 已安装但脚本端口没响应：打开 偏好设置 › 系统 › 常规，把「外部脚本使用 / External scripting using」设为 本地(Local)。',
    )
  }
  if (studio && !running) notes.push('Resolve 没在运行：脚本 API 需要 Resolve 开着。')

  return {
    exePath,
    resolvePython: resolvePython && existsSync(resolvePython) ? resolvePython : null,
    fusionscript: fusionscript && existsSync(fusionscript) ? fusionscript : null,
    productName,
    version: versionInfo?.ProductVersion ?? versionInfo?.FileVersion ?? null,
    edition: studio ? 'studio' : exePath ? 'free' : 'unknown',
    studio,
    running,
    scriptingPortOpen,
    backend,
    canDriveLive: backend === 'api' && running,
    notes,
  }
}

let client = null

class BridgeClient {
  constructor(pythonPath, envextra) {
    this.pythonPath = pythonPath
    this.env = envextra
    this.proc = null
    this.buffer = ''
    this.pending = new Map()
    this.nextId = 1
    this.lastError = null
  }

  start() {
    if (this.proc) return
    const args = [BRIDGE]
    this.proc = spawn(this.pythonPath, args, {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk) => this.onData(chunk))
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk) => {
      this.lastError = chunk.trim() || this.lastError
    })
    this.proc.on('exit', (code) => {
      this.lastError = this.lastError || `bridge exited with code ${code}`
      for (const [, entry] of this.pending) entry.reject(new Error(this.lastError))
      this.pending.clear()
      this.proc = null
    })
    this.proc.on('error', (error) => {
      this.lastError = error.message
      this.proc = null
    })
  }

  onData(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let payload
      try {
        payload = JSON.parse(line)
      } catch {
        continue
      }
      const entry = this.pending.get(payload.id)
      if (!entry) continue
      this.pending.delete(payload.id)
      clearTimeout(entry.timer)
      if (payload.ok) entry.resolve(payload.result)
      else entry.reject(new Error(payload.error || 'bridge call failed'))
    }
  }

  request(op, args = {}, timeoutMs = 60_000) {
    this.start()
    if (!this.proc) return Promise.reject(new Error(this.lastError || 'bridge did not start'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`bridge call "${op}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.proc.stdin.write(JSON.stringify({ id, op, args }) + '\n')
    })
  }

  close() {
    if (this.proc) {
      try {
        this.proc.stdin.end()
        this.proc.kill()
      } catch {
        // ignore
      }
      this.proc = null
    }
  }
}

/** Lazily create (and reuse) the live bridge to a running Resolve Studio. */
export async function getBridge(options = {}) {
  if (client) return client
  const info = await detect(options)
  if (info.backend !== 'api') {
    const err = new Error(
      info.studio
        ? 'Resolve Studio 的脚本端口没开（偏好设置 › 系统 › 常规 › 外部脚本使用 = 本地），或 Resolve 没运行。'
        : '这是免费版 Resolve，没有外部脚本 API；请用 resolve_build 生成可导入成片。',
    )
    err.code = 'NO_SCRIPTING'
    err.detect = info
    throw err
  }
  const python = info.resolvePython ?? process.env.RESOLVE_PYTHON
  if (!python) {
    const err = new Error('找不到 Resolve 自带的 ResolvePython.exe，无法启动脚本桥。')
    err.code = 'NO_PYTHON'
    throw err
  }
  client = new BridgeClient(python, {
    RESOLVE_SCRIPT_API: SCRIPT_API,
    RESOLVE_SCRIPT_LIB: info.fusionscript ?? '',
  })
  return client
}

export function resetBridge() {
  if (client) client.close()
  client = null
}
