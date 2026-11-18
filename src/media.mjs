import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, findPython, ensureDir } from './util.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOOL = path.join(HERE, '..', 'bridge', 'media_tools.py')

let tmpSeq = 0

async function callTool(pythonPath, command, request) {
  const python = await findPython(pythonPath)
  const tmpDir = await fs.mkdtemp(path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'dsh-resolve-'))
  const reqFile = path.join(tmpDir, `req-${++tmpSeq}.json`)
  await fs.writeFile(reqFile, JSON.stringify(request), 'utf8')
  try {
    const { stdout } = await run(python.path, [TOOL, command, reqFile], { timeout: 120_000 })
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}'
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`media tool returned non-JSON output: ${line.slice(0, 300)}`)
    }
    parsed._python = python.path
    return parsed
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function probeMedia(pythonPath, filePath, options = {}) {
  return callTool(pythonPath, 'probe', {
    path: filePath,
    frames: options.frames ?? 0,
    assumedFps: options.assumedFps ?? 25,
  })
}

export async function renderTitle(pythonPath, options) {
  const out = options.out
  await ensureDir(path.dirname(out))
  return callTool(pythonPath, 'title', {
    text: options.text,
    sub: options.sub ?? '',
    width: options.width,
    height: options.height,
    style: options.style ?? 'center',
    size: options.size,
    font: options.font,
    color: options.color,
    accent: options.accent,
    opacity: options.opacity ?? 255,
    out,
  })
}

export async function renderSolid(pythonPath, options) {
  const out = options.out
  await ensureDir(path.dirname(out))
  return callTool(pythonPath, 'solid', {
    width: options.width,
    height: options.height,
    color: options.color ?? [0, 0, 0],
    out,
  })
}
