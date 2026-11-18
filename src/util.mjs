import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 60_000, ...options },
      (error, stdout, stderr) => {
        if (error) {
          const err = new Error(`${path.basename(cmd)} failed: ${error.message}`)
          err.stdout = stdout
          err.stderr = stderr
          err.code = error.code
          reject(err)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}

const PYTHON_CANDIDATES = () => {
  const out = []
  const local = process.env.LOCALAPPDATA
  if (local) {
    for (const version of ['313', '312', '311', '310', '39']) {
      out.push(path.join(local, 'Programs', 'Python', `Python${version}`, 'python.exe'))
    }
  }
  out.push('C:\\Python313\\python.exe', 'C:\\Python312\\python.exe', 'C:\\Python311\\python.exe')
  out.push('/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3')
  return out
}

let cachedPython = null

/**
 * Find a Python interpreter that can import the image libs this plugin needs.
 * Resolve's bundled interpreter is deliberately skipped: it ships without Pillow.
 */
export async function findPython(preferred) {
  const explicit = preferred ?? process.env.DSH_RESOLVE_PYTHON ?? process.env.PYTHON
  if (explicit && existsSync(explicit)) {
    const ok = await pythonCanImport(explicit, ['PIL'])
    if (ok) return { path: explicit, hasPil: true, hasCv2: await pythonCanImport(explicit, ['cv2']) }
  }
  if (cachedPython) return cachedPython

  const tried = []
  for (const candidate of PYTHON_CANDIDATES()) {
    if (!existsSync(candidate)) continue
    tried.push(candidate)
    if (!(await pythonCanImport(candidate, ['PIL']))) continue
    cachedPython = { path: candidate, hasPil: true, hasCv2: await pythonCanImport(candidate, ['cv2']) }
    return cachedPython
  }
  // Last resort: whatever `python` resolves to on PATH.
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', ['python'], { timeout: 10_000 })
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    if (first && existsSync(first) && (await pythonCanImport(first, ['PIL']))) {
      cachedPython = { path: first, hasPil: true, hasCv2: await pythonCanImport(first, ['cv2']) }
      return cachedPython
    }
  } catch {
    // ignore
  }
  const err = new Error(
    'No Python with Pillow was found. Install Python 3.10+ and `pip install pillow`, ' +
      'or pass config.pythonPath. Tried: ' + (tried.join(', ') || 'nothing'),
  )
  err.code = 'PYTHON_NOT_FOUND'
  throw err
}

async function pythonCanImport(pythonPath, modules) {
  const code = `import importlib.util as u, sys; sys.exit(0 if all(u.find_spec(m) for m in ${JSON.stringify(modules)}) else 1)`
  try {
    await run(pythonPath, ['-c', code], { timeout: 20_000 })
    return true
  } catch {
    return false
  }
}

export function expandPath(p, base) {
  if (!p) return p
  let out = String(p).trim()
  if (out.startsWith('~')) out = path.join(os.homedir(), out.slice(1))
  if (!path.isAbsolute(out)) out = path.resolve(base ?? process.cwd(), out)
  return path.normalize(out)
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/**
 * Turn a path into a file:// URL that FCPXML importers accept.
 *
 * Keep non-ASCII characters raw: Resolve on Windows does not percent-decode the
 * src attribute, so encoding an accented or Chinese account name turns the clip
 * offline.
 */
export function fileUrl(p) {
  const normalized = path.resolve(p).replace(/\\/g, '/')
  const prefixed = normalized.startsWith('/') ? normalized : '/' + normalized
  return 'file://' + prefixed
}

export function slugify(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'Untitled Edit'
}

export async function fileSize(p) {
  try {
    const st = await fs.stat(p)
    return st.size
  } catch {
    return 0
  }
}
