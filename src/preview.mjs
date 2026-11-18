import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { run, findPython, ensureDir, expandPath } from './util.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOOL = path.join(HERE, '..', 'bridge', 'preview.py')

const FFMPEG_CANDIDATES = [
  () => process.env.FFMPEG_PATH,
  () => process.env.FFMPEG_EXE,
  () => path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'bin', 'ffmpeg.exe'),
  () => '/usr/local/bin/ffmpeg',
  () => '/opt/homebrew/bin/ffmpeg',
  () => '/usr/bin/ffmpeg',
]

let cachedFfmpeg

/** Explicit env var, then the usual install spots, then whatever PATH resolves. */
export async function findFfmpeg() {
  if (cachedFfmpeg !== undefined) return cachedFfmpeg
  for (const candidate of FFMPEG_CANDIDATES) {
    const p = candidate()
    if (!p) continue
    try {
      await fs.access(p)
      cachedFfmpeg = p
      return p
    } catch {
      // keep looking
    }
  }
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { timeout: 10_000 })
    const first = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)[0]
    if (first) {
      await fs.access(first)
      cachedFfmpeg = first
      return first
    }
  } catch {
    // not on PATH
  }
  cachedFfmpeg = null
  return null
}

/**
 * Pick representative frames when the caller does not name any.
 * Avoids the very first/last frame, where fades and black frames mislead.
 */
export function pickFrames(totalFrames, count = 4) {
  const total = Math.max(1, Math.round(totalFrames))
  if (total <= count) return Array.from({ length: total }, (_, i) => i)
  const inset = Math.min(Math.floor(total * 0.04), 12)
  const span = total - inset * 2
  return Array.from({ length: count }, (_, i) =>
    Math.round(inset + (span * i) / (count - 1)),
  )
}

/**
 * Rebuild frames of a built edit without Resolve: ffmpeg pulls the source frame,
 * Pillow composites the overlays that are active at that frame.
 */
export async function renderPreview(options = {}) {
  const dir = expandPath(options.dir ?? '.', options.baseDir)
  const manifestPath = options.manifestPath ?? path.join(dir, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  } catch {
    throw new Error(`no manifest at ${manifestPath} — run resolve_build with outputDir=${dir} first`)
  }

  const width = manifest.timeline?.width ?? 1920
  const height = manifest.timeline?.height ?? 1080
  const fps = manifest.timeline?.fps ?? 25
  const totalFrames = manifest.timeline?.frames ?? 1

  const requested = Array.isArray(options.frames) && options.frames.length
    ? options.frames.map((v) => Math.max(0, Math.round(Number(v))))
    : pickFrames(totalFrames, options.count ?? 4)

  const outDir = await ensureDir(options.outDir ?? path.join(dir, 'preview'))
  const python = await findPython(options.pythonPath)
  const ffmpeg = await findFfmpeg()

  const request = {
    width,
    height,
    fps,
    outDir,
    frames: requested,
    ffmpeg,
    sheet: options.sheet !== false,
    sheetColumns: options.columns ?? 2,
    clips: (manifest.clips ?? []).map((c) => ({
      file: c.file,
      kind: c.kind,
      startFrames: c.startFrames,
      durationFrames: c.durationFrames,
      sourceStartFrames: c.sourceStartFrames ?? 0,
    })),
    overlays: (manifest.titles ?? []).map((t) => ({
      file: t.file,
      startFrames: t.startFrames,
      durationFrames: t.durationFrames,
    })),
  }

  const tmpDir = await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'dsh-prev-'))
  const reqFile = path.join(tmpDir, 'req.json')
  await fs.writeFile(reqFile, JSON.stringify(request), 'utf8')
  try {
    const { stdout } = await run(python.path, [TOOL, reqFile], { timeout: 180_000 })
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}'
    const parsed = JSON.parse(line)
    if (!parsed.ok) throw new Error(parsed.error ?? 'preview failed')
    return { ...parsed, dir: outDir, manifestPath }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}
