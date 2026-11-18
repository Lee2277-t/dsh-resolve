import { fileUrl } from './util.mjs'

/** Frame rates Resolve recognises as FCP X format names. */
const FORMAT_RATES = {
  23.976: { name: '2398', frameDuration: '1001/24000s' },
  24: { name: '24', frameDuration: '1/24s' },
  25: { name: '25', frameDuration: '1/25s' },
  29.97: { name: '2997', frameDuration: '1001/30000s' },
  30: { name: '30', frameDuration: '1/30s' },
  50: { name: '50', frameDuration: '1/50s' },
  59.94: { name: '5994', frameDuration: '1001/60000s' },
  60: { name: '60', frameDuration: '1/60s' },
}

export function rateInfo(fps) {
  const numeric = Number(fps)
  const key = Object.keys(FORMAT_RATES).find((k) => Math.abs(Number(k) - numeric) < 0.02)
  if (key) return { fps: Number(key), ...FORMAT_RATES[key] }
  // Unknown rate: emit an exact rational so the import stays frame-accurate.
  return { fps: numeric, name: String(Math.round(numeric * 100) / 100).replace('.', ''), frameDuration: `1/${numeric}s` }
}

export function formatName(width, height, rate) {
  const h = Number(height)
  const w = Number(width)
  // Resolve names standard sources by height ("1080p25"); anything taller than
  // 1080 or non-standard falls back to the explicit pixel size, which it accepts.
  if (h === 1080) return `FFVideoFormat1080p${rate.name}`
  if (h === 720) return `FFVideoFormat720p${rate.name}`
  if (h === 2160) return `FFVideoFormat2160p${rate.name}`
  return `FFVideoFormat${w}x${h}p${rate.name}`
}

function frames(value, rate) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string' && value.includes('s')) return value
  const n = Math.round(Number(value))
  return n === 0 ? '0s' : `${n}/${rate.fps}s`
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const TRANSITION_UIDS = {
  'Cross Dissolve': 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265',
  'Fade to Color': 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265',
}

/**
 * Build FCPXML 1.9 from a normalised plan.
 * plan = { name, width, height, fps, clips: [], overlays: [], transitions: [] }
 * Every entry carries frame numbers already resolved by the planner.
 */
export function buildFcpxml(plan) {
  const rate = rateInfo(plan.fps)
  const resources = []
  const assetIds = new Map()
  let resourceSeq = 0

  const formatId = 'r1'
  resources.push(
    `    <format id="${formatId}" name="${formatName(plan.width, plan.height, rate)}" ` +
      `frameDuration="${rate.frameDuration}" width="${plan.width}" height="${plan.height}"/>`,
  )

  const assetFor = (item) => {
    const key = item.file
    if (assetIds.has(key)) return assetIds.get(key)
    const id = `a${++resourceSeq}`
    assetIds.set(key, id)
    const durationFrames = Math.max(item.assetFrames || item.durationFrames || 1, item.durationFrames || 1, 1)
    const hasAudio = item.kind === 'video' && item.hasAudio ? 1 : 0
    const hasVideo = 1
    const attrs = [
      `id="${id}"`,
      `name="${escapeXml(item.name || key.split(/[\\/]/).pop())}"`,
      'start="0s"',
      `duration="${frames(durationFrames, rate)}"`,
      `hasVideo="${hasVideo}"`,
      `hasAudio="${hasAudio}"`,
      `format="${formatId}"`,
      'videoSources="1"',
    ].join(' ')
    resources.push(`    <asset ${attrs}>\n      <media-rep kind="original-media" src="${escapeXml(fileUrl(key))}"/>\n    </asset>`)
    return id
  }

  const transitionIds = new Map()
  let effectSeq = 0
  const effectFor = (type) => {
    const name = type || 'Cross Dissolve'
    if (transitionIds.has(name)) return transitionIds.get(name)
    const id = `e${++effectSeq}`
    transitionIds.set(name, id)
    const uid = TRANSITION_UIDS[name] ?? TRANSITION_UIDS['Cross Dissolve']
    resources.push(`    <effect id="${id}" name="${escapeXml(name)}" uid="${uid}"/>`)
    return id
  }

  const spine = []
  let primaryCursor = 0
  let sequenceEnd = 0

  plan.clips.forEach((clip, index) => {
    const ref = assetFor(clip)
    const transitionBefore = plan.transitions.find((t) => t.after === index - 1 && index > 0)
    const overlap = transitionBefore ? Math.floor(transitionBefore.durationFrames / 2) : 0
    const startFrame = index === 0 ? 0 : primaryCursor - overlap
    const dur = clip.durationFrames
    const attrs = [
      `ref="${ref}"`,
      `offset="${frames(startFrame, rate)}"`,
      `name="${escapeXml(clip.name || `Clip ${index + 1}`)}"`,
      `start="${frames(clip.sourceStartFrames || 0, rate)}"`,
      `duration="${frames(dur, rate)}"`,
      clip.kind === 'video' && clip.hasAudio ? 'audioRole="dialogue"' : null,
    ].filter(Boolean).join(' ')

    if (transitionBefore && index > 0) {
      const effectId = effectFor(transitionBefore.type)
      spine.push(
        `          <transition offset="${frames(startFrame, rate)}" ` +
          `duration="${frames(transitionBefore.durationFrames, rate)}">` +
          `<filter-video ref="${effectId}" name="${escapeXml(transitionBefore.type || 'Cross Dissolve')}"/>` +
          `</transition>`,
      )
    }

    spine.push(`          <asset-clip ${attrs}/>`)
    primaryCursor = startFrame + dur
    sequenceEnd = Math.max(sequenceEnd, primaryCursor)
  })

  plan.overlays.forEach((item, index) => {
    const ref = assetFor(item)
    // Each overlay gets its own lane: stacking two overlapping clips on one lane is invalid.
    const lane = item.lane ?? index + 1
    const attrs = [
      `ref="${ref}"`,
      `lane="${lane}"`,
      `offset="${frames(item.startFrames, rate)}"`,
      `name="${escapeXml(item.name || `Overlay ${index + 1}`)}"`,
      'start="0s"',
      `duration="${frames(item.durationFrames, rate)}"`,
    ].join(' ')
    spine.push(`          <asset-clip ${attrs}/>`)
    sequenceEnd = Math.max(sequenceEnd, item.startFrames + item.durationFrames)
  })

  const sequenceDuration = Math.max(sequenceEnd, 1)

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.9">',
    '  <resources>',
    ...resources,
    '  </resources>',
    '  <library>',
    `    <event name="DSH Resolve">`,
    `      <project name="${escapeXml(plan.name)}">`,
    `        <sequence format="${formatId}" duration="${frames(sequenceDuration, rate)}" ` +
      `tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
    '          <spine>',
    ...spine,
    '          </spine>',
    '        </sequence>',
    '      </project>',
    '    </event>',
    '  </library>',
    '</fcpxml>',
    '',
  ].join('\n')
}

/**
 * Self-check the generated document. Catches the mistakes that make Resolve
 * silently drop a timeline: dangling refs, duplicate ids, an empty spine.
 */
export function validateFcpxml(xml) {
  const problems = []
  const ids = new Set()
  for (const match of xml.matchAll(/\sid="([^"]+)"/g)) {
    if (ids.has(match[1])) problems.push(`duplicate id "${match[1]}"`)
    ids.add(match[1])
  }
  for (const match of xml.matchAll(/\sref="([^"]+)"/g)) {
    if (!ids.has(match[1])) problems.push(`ref "${match[1]}" has no matching id`)
  }
  if (!/<spine>[\s\S]*<asset-clip/.test(xml)) problems.push('spine has no asset-clip')
  for (const match of xml.matchAll(/\sduration="0\/[^"]*"/g)) {
    problems.push(`zero duration near ${match.index}`)
  }
  if (!/<sequence[^>]+duration="\d+\/\d+s"/.test(xml)) problems.push('sequence duration missing or malformed')
  if (!/<media-rep kind="original-media" src="file:\/\//.test(xml)) problems.push('no media-rep with a file:// src')
  return problems
}
