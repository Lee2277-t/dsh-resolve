/**
 * Self-test for dsh-resolve. No test framework, no network, no Resolve.
 *
 *   node test/self-test.mjs
 *
 * It renders plates and titles with Pillow, builds a timeline, and checks the
 * .fcpxml the way Resolve would read it. Everything is written to a temp folder
 * and removed afterwards, so it is safe to run on a machine with real projects.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { buildEdit, letterSuffix, toTimecode } from '../src/build.mjs'
import { buildFcpxml, formatName, rateInfo, validateFcpxml } from '../src/fcpxml.mjs'
import { pickFrames } from '../src/preview.mjs'
import { findPython } from '../src/util.mjs'

const results = []

async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error?.message ?? String(error) })
  }
}

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-resolve-test-'))

try {
  await check('python with Pillow is available', async () => {
    const python = await findPython()
    assert.ok(python?.path, 'no Python with Pillow found (pip install pillow, or set DSH_RESOLVE_PYTHON)')
  })

  await check('title file names never contain digits', async () => {
    const names = Array.from({ length: 120 }, (_, index) => `title-${letterSuffix(index)}.png`)
    assert.equal(new Set(names).size, names.length, 'duplicate title file name')
    assert.ok(names.every((name) => !/\d/.test(name)), 'a title file name contains a digit')
    assert.equal(letterSuffix(0), 'a')
    assert.equal(letterSuffix(25), 'z')
    assert.equal(letterSuffix(26), 'aa')
    assert.equal(letterSuffix(51), 'az')
    assert.equal(letterSuffix(52), 'ba')
  })

  await check('frame-rate table and format names', async () => {
    assert.equal(rateInfo(29.97).name, '2997')
    assert.equal(rateInfo(25).frameDuration, '1/25s')
    assert.equal(formatName(1920, 1080, rateInfo(25)), 'FFVideoFormat1080p25')
    assert.equal(formatName(3840, 2160, rateInfo(24)), 'FFVideoFormat2160p24')
    assert.equal(formatName(1080, 1920, rateInfo(30)), 'FFVideoFormat1080x1920p30')
  })

  await check('timecode', async () => {
    assert.equal(toTimecode(0, 25), '00:00:00:00')
    assert.equal(toTimecode(25 * 61 + 4, 25), '00:01:01:04')
  })

  await check('frame picking stays inside the timeline', async () => {
    const picked = pickFrames(100, 4)
    assert.equal(picked.length, 4)
    assert.ok(picked.every((frame) => frame >= 0 && frame < 100))
    assert.deepEqual(pickFrames(2, 4), [0, 1])
  })

  await check('generated fcpxml passes its own validator', async () => {
    const xml = buildFcpxml({
      name: 'Validator Only',
      width: 1920,
      height: 1080,
      fps: 25,
      clips: [
        {
          file: path.join(workDir, 'a.png'),
          name: 'A',
          kind: 'image',
          hasAudio: false,
          startFrames: 0,
          durationFrames: 50,
          assetFrames: 50,
          sourceStartFrames: 0,
        },
      ],
      overlays: [],
      transitions: [],
    })
    assert.deepEqual(validateFcpxml(xml), [])
  })

  await check('build writes an importable timeline with titles and dissolves', async () => {
    const outDir = path.join(workDir, 'edit')
    await fs.mkdir(path.join(outDir, 'assets'), { recursive: true })
    const plates = [
      { name: 'plate-a.png', color: [24, 28, 40] },
      { name: 'plate-b.png', color: [40, 24, 32] },
      { name: 'plate-c.png', color: [16, 18, 24] },
    ].map((plate) => ({ ...plate, file: path.join(outDir, 'assets', plate.name) }))
    const { renderSolid } = await import('../src/media.mjs')
    for (const plate of plates) {
      await renderSolid(undefined, { width: 640, height: 360, color: plate.color, out: plate.file })
    }

    const manifest = await buildEdit(
      {
        name: 'Self Test Edit',
        width: 640,
        height: 360,
        fps: 25,
        clips: plates.map((plate, index) => ({ file: plate.file, duration: 50 + index * 10, name: `plate ${index}` })),
        titles: [
          { text: '自测标题', sub: 'subtitle', at: 10, duration: 40, style: 'center' },
          { text: 'Lower third', style: 'lower', at: '1s', duration: '2s' },
        ],
        transitions: [{ after: 0, type: 'Cross Dissolve', duration: 12 }],
      },
      { outputDir: outDir, baseDir: outDir },
    )

    assert.equal(manifest.ok, true)
    const xml = await fs.readFile(manifest.timelinePath, 'utf8')
    assert.deepEqual(validateFcpxml(xml), [], 'self-check found problems')
    assert.ok(xml.includes('<transition'), 'cross dissolve missing from the spine')
    assert.ok(xml.includes('lane="1"') && xml.includes('lane="2"'), 'each title needs its own lane')
    assert.ok(!/%[0-9A-F]{2}/.test(xml.match(/src="[^"]*"/)?.[0] ?? ''), 'media src must stay un-encoded for non-ASCII paths')
    assert.equal(manifest.transitions.length, 1)
    assert.equal(manifest.titles.length, 2)
    assert.equal(manifest.timeline.fps, 25)

    const onDisk = await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8')
    assert.equal(JSON.parse(onDisk).timelinePath, manifest.timelinePath)
  })

  await check('missing media fails with a clear message', async () => {
    await assert.rejects(
      () => buildEdit({ clips: [{ file: path.join(workDir, 'nope.mp4') }] }, { outputDir: path.join(workDir, 'missing') }),
      /file not found/,
    )
  })

  await check('an empty spec is rejected before anything is written', async () => {
    await assert.rejects(
      () => buildEdit({ name: 'Empty' }, { outputDir: path.join(workDir, 'empty') }),
      /spec\.clips is empty/,
    )
  })
} finally {
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
}

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n      ${result.error}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
