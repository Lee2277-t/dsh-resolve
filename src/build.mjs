import { promises as fs } from 'node:fs'
import path from 'node:path'
import { expandPath, ensureDir, slugify } from './util.mjs'
import { probeMedia, renderTitle } from './media.mjs'
import { buildFcpxml, rateInfo, validateFcpxml } from './fcpxml.mjs'

const DEFAULT_TITLE_FRAMES = 75

/**
 * a, b, ... z, aa, ab, ...  Letters only: a digit anywhere in the file name makes
 * Resolve read the title PNGs as an image sequence and then go offline.
 */
function letterSuffix(index) {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(97 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

export { letterSuffix }

function toFrames(value, fps, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'number') return Math.round(value)
  const text = String(value).trim()
  if (/^\d+(\.\d+)?s$/.test(text)) return Math.round(parseFloat(text) * fps)
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(parseFloat(text))
  return fallback
}

function normalizeRgb(value, fallback = [255, 255, 255]) {
  if (!Array.isArray(value) || value.length !== 3) return fallback
  return value.map((v) => Math.max(0, Math.min(255, Math.round(Number(v)))))
}

/**
 * Turn a declarative edit spec into a Resolve-importable package.
 * Returns a manifest describing exactly what was produced.
 */
export async function buildEdit(spec, options = {}) {
  const warnings = []
  if (!spec || typeof spec !== 'object') throw new Error('spec must be an object')

  const fps = Number(spec.fps ?? options.fps ?? 25)
  const width = Math.round(Number(spec.width ?? 1920))
  const height = Math.round(Number(spec.height ?? 1080))
  if (!(fps > 0)) throw new Error('fps must be a positive number')
  if (!(width > 0 && height > 0)) throw new Error('width/height must be positive')

  const rate = rateInfo(fps)
  const name = slugify(spec.name ?? options.name ?? 'DSH Edit')
  const outputDir = await ensureDir(expandPath(options.outputDir ?? spec.outputDir ?? process.cwd()))
  const assetsDir = await ensureDir(path.join(outputDir, 'assets'))

  const rawClips = Array.isArray(spec.clips) ? spec.clips : []
  if (rawClips.length === 0 && !(Array.isArray(spec.titles) && spec.titles.length)) {
    throw new Error('spec.clips is empty: give at least one clip or a title card')
  }

  const clips = []
  for (const [index, raw] of rawClips.entries()) {
    const file = expandPath(raw.file ?? raw.path ?? raw.source, options.baseDir)
    try {
      await fs.access(file)
    } catch {
      throw new Error(`clips[${index}]: file not found -> ${file}`)
    }
    const probe = await probeMedia(options.pythonPath, file, { assumedFps: fps })
    if (!probe.ok) throw new Error(`clips[${index}]: ${probe.error} (${file})`)

    const mediaFrames = probe.frames && probe.frames > 0
      ? probe.frames
      : toFrames(raw.duration, fps, Math.round(fps * 5))
    const sourceStart = toFrames(raw.in ?? raw.start, fps, 0)
    const requested = toFrames(raw.duration, fps, null)
    let durationFrames = requested ?? Math.max(1, mediaFrames - sourceStart)
    durationFrames = Math.min(durationFrames, Math.max(1, mediaFrames - sourceStart))

    if (probe.kind === 'video' && probe.width && probe.height) {
      const sameShape = Math.abs(probe.width / probe.height - width / height) < 0.02
      if (!sameShape) {
        warnings.push(
          `clips[${index}] ${path.basename(file)} is ${probe.width}x${probe.height}, timeline is ${width}x${height}; Resolve will fit it on import.`,
        )
      }
    }
    if (probe.kind === 'video' && probe.fps && Math.abs(probe.fps - rate.fps) > 0.05) {
      warnings.push(
        `clips[${index}] ${path.basename(file)} is ${probe.fps}fps on a ${rate.fps}fps timeline; Resolve will conform it.`,
      )
    }

    clips.push({
      file,
      name: raw.name ?? path.parse(file).name,
      kind: probe.kind,
      hasAudio: probe.kind === 'video' ? probe.hasAudio !== false : false,
      assetFrames: Math.max(mediaFrames, durationFrames + sourceStart),
      sourceStartFrames: sourceStart,
      durationFrames,
    })
  }

  // Layout primary storyline back to back.
  let cursor = 0
  for (const clip of clips) {
    clip.startFrames = cursor
    cursor += clip.durationFrames
  }
  const primaryEnd = cursor

  const overlays = []
  const renderedTitles = []
  const rawTitles = Array.isArray(spec.titles) ? spec.titles : []
  for (const [index, raw] of rawTitles.entries()) {
    const text = String(raw.text ?? '').trim()
    if (!text) {
      warnings.push(`titles[${index}] has no text and was skipped`)
      continue
    }
    // No digits in the name: Resolve reads "title-01.png" + "title-02.png" as an
    // image sequence (it shows title-[01-45].png) and then goes offline.
    const suffix = letterSuffix(index)
    const out = path.join(assetsDir, `title-${suffix}.png`)
    const rendered = await renderTitle(options.pythonPath, {
      text,
      sub: raw.sub ?? raw.subtitle ?? '',
      width,
      height,
      style: raw.style === 'lower' || raw.position === 'lower' ? 'lower' : 'center',
      size: raw.size,
      font: raw.font ? expandPath(raw.font, options.baseDir) : undefined,
      color: normalizeRgb(raw.color),
      accent: normalizeRgb(raw.accent, [255, 176, 32]),
      out,
    })
    if (!rendered.ok) throw new Error(`titles[${index}]: ${rendered.error}`)

    const startFrames = toFrames(raw.at ?? raw.start, fps, 0)
    const durationFrames = toFrames(raw.duration, fps, Math.max(1, Math.min(DEFAULT_TITLE_FRAMES, primaryEnd || DEFAULT_TITLE_FRAMES)))
    overlays.push({
      file: out,
      name: text.slice(0, 28),
      kind: 'image',
      hasAudio: false,
      startFrames,
      durationFrames,
      assetFrames: durationFrames,
    })
    renderedTitles.push({ text, file: out, startFrames, durationFrames, style: rendered.style ?? raw.style ?? 'center' })
  }

  const transitions = []
  for (const [index, raw] of (Array.isArray(spec.transitions) ? spec.transitions : []).entries()) {
    const after = Number(raw.after ?? raw.index ?? 0)
    if (!Number.isInteger(after) || after < 0 || after >= clips.length - 1) {
      warnings.push(`transitions[${index}] skipped: "after" must be a clip index with a following clip`)
      continue
    }
    let durationFrames = toFrames(raw.duration, fps, Math.round(fps * 0.5))
    durationFrames = Math.max(2, Math.min(durationFrames, Math.floor(clips[after].durationFrames / 2), Math.floor(clips[after + 1].durationFrames / 2)))
    if (durationFrames % 2 === 1) durationFrames += 1
    transitions.push({ after, type: raw.type ?? 'Cross Dissolve', durationFrames })
  }

  const plan = { name, width, height, fps: rate.fps, clips, overlays, transitions }
  const xml = buildFcpxml(plan)
  const problems = validateFcpxml(xml)
  if (problems.length) {
    throw new Error(`generated timeline failed self-check: ${problems.join('; ')}`)
  }

  const timelinePath = path.join(outputDir, `${name}.fcpxml`)
  await fs.writeFile(timelinePath, xml, 'utf8')

  const totalOverlap = transitions.reduce((sum, t) => sum + Math.floor(t.durationFrames / 2), 0)
  const sequenceFrames = Math.max(1, primaryEnd - totalOverlap)
  const seconds = sequenceFrames / rate.fps

  const manifest = {
    ok: true,
    backend: options.backend ?? 'file',
    name,
    timelinePath,
    assetsDir,
    timeline: {
      width,
      height,
      fps: rate.fps,
      frames: sequenceFrames,
      seconds: Number(seconds.toFixed(3)),
      timecode: toTimecode(sequenceFrames, rate.fps),
    },
    clips: clips.map((c) => ({
      name: c.name,
      file: c.file,
      startFrames: c.startFrames,
      durationFrames: c.durationFrames,
      sourceStartFrames: c.sourceStartFrames,
      kind: c.kind,
    })),
    titles: renderedTitles,
    transitions,
    warnings,
    next: [
      '在 Resolve 里：文件 › 导入 › 时间线… 选择这个 .fcpxml（或把它拖进媒体池）。',
      '导入后时间线会自动出现在媒体池，双击即可开始改。',
    ],
  }
  await fs.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return manifest
}

export function toTimecode(frames, fps) {
  const total = Math.max(0, Math.round(frames))
  const rounded = Math.round(fps)
  const ff = total % rounded
  const totalSeconds = Math.floor(total / rounded)
  const ss = totalSeconds % 60
  const mm = Math.floor(totalSeconds / 60) % 60
  const hh = Math.floor(totalSeconds / 3600)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(ff).padStart(2, '0')}`
}
