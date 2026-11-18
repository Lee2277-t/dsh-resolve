import path from 'node:path'
import { existsSync, promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildEdit } from './src/build.mjs'
import { detect, getBridge, resetBridge, tcpOpen } from './src/resolve.mjs'
import { renderPreview } from './src/preview.mjs'
import { enqueue, waitForResult, readState, queueDepth, clickHint, scriptsDir, resolveConfigRoot, BRIDGE_FILENAME } from './src/inapp.mjs'
import { HELP, SPEC_TOPIC } from './src/help.mjs'

export const name = 'dsh-resolve'
export const inject = ['tools']

function json(value) {
  return JSON.stringify(value, null, 2)
}

function fail(error, extra = {}) {
  return json({ ok: false, error: error?.message ?? String(error), ...extra })
}

/** Probe whether a path looks like an image the attachment store accepts. */
function mediaTypeOf(file) {
  const extension = path.extname(file).toLowerCase()
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  return 'image/png'
}

/**
 * Publish a rendered PNG through the durable attachment store so a tool result
 * can carry a real image block. A tool result may only reference an image by
 * durable attachment id; `{ type: 'image', path }` is not a content block and
 * makes the next model request fail while it reads `attachment.attachmentId`.
 */
export async function attachImage(ctx, file, name) {
  if (!file) return null
  const attachments = ctx.get('attachments')
  if (!attachments) return null
  try {
    const data = await fs.readFile(file)
    const ref = await attachments.saveImage({
      data: new Uint8Array(data),
      mediaType: mediaTypeOf(file),
      name: name ?? path.basename(file),
    })
    return {
      attachmentId: String(ref.attachmentId),
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
    }
  } catch {
    // Oversized or unsupported sheets stay text-only; the path is still reported.
    return null
  }
}

function sessionDir(ctx, exec) {
  try {
    const session = exec?.agent?.session
    const workingDirectory = ctx.get('workingDirectory')
    if (session && workingDirectory?.get) return workingDirectory.get(session)
  } catch {
    // fall through
  }
  return exec?.agent?.cwd ?? process.cwd()
}

const OUTPUT_TOOL = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/**
 * Keep bridge/inapp_bridge.py present in Resolve's Utility scripts folder, so the
 * free edition can be driven from Workspace > Scripts with no manual copying.
 */
async function installBridgeScript() {
  try {
    const source = fileURLToPath(new URL('./bridge/inapp_bridge.py', import.meta.url))
    const dest = path.join(scriptsDir(), BRIDGE_FILENAME)
    // Only touch the Resolve config tree when Resolve is actually installed here.
    if (!existsSync(resolveConfigRoot())) return null
    await fs.mkdir(path.dirname(dest), { recursive: true })
    const [incoming, current] = await Promise.all([
      fs.readFile(source, 'utf8'),
      fs.readFile(dest, 'utf8').catch(() => null),
    ])
    if (incoming !== current) await fs.writeFile(dest, incoming, 'utf8')
    return dest
  } catch {
    return null
  }
}

export function apply(ctx, config = {}) {
  const options = {
    resolveExe: config.resolveExe,
    pythonPath: config.pythonPath,
  }

  if (config.installBridgeScript !== false) void installBridgeScript()

  ctx.tools.register({
    name: 'resolve_doctor',
    description:
      'Inspect the local DaVinci Resolve install and tell you which backend works: "api" (Resolve Studio with ' +
      'external scripting on, so edits are built live) or "file" (free edition, so edits are written as an ' +
      'importable .fcpxml). Reports edition, version, whether Resolve is running, and what to fix. Call this first.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 60_000,
    output: OUTPUT_TOOL,
    async execute() {
      try {
        const info = await detect(options)
        return json({ ok: true, ...info })
      } catch (error) {
        return fail(error)
      }
    },
  })

  ctx.tools.register({
    name: 'resolve_help',
    description:
      'Return the edit-spec reference for resolve_build: field names, units (frames), title styles, transitions, ' +
      'and the v1 limits. Read once before writing the first spec.',
    parameters: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'Optional: spec | limits' } },
      additionalProperties: false,
    },
    timeoutMs: 10_000,
    output: OUTPUT_TOOL,
    async execute(args) {
      return SPEC_TOPIC[args.topic] ?? HELP
    },
  })

  ctx.tools.register({
    name: 'resolve_build',
    description:
      'Build a finished edit from a declarative spec: ordered clips, rendered title overlays, cross dissolves. ' +
      'Writes a Resolve-importable .fcpxml plus its assets and returns the manifest. In "api" mode (Resolve Studio) ' +
      'it also imports the timeline straight into the running project when apply=true. This replaces clicking ' +
      'around in the Resolve UI. Call resolve_help for the spec shape.',
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'object', additionalProperties: true, description: 'Edit spec. See resolve_help.' },
        name: { type: 'string', description: 'Timeline name; overrides spec.name.' },
        outputDir: { type: 'string', description: 'Where to write the .fcpxml + assets. Defaults to <session dir>/resolve-edits.' },
        fps: { type: 'number', description: 'Timeline frame rate; overrides spec.fps. Default 25.' },
        apply: { type: 'boolean', description: 'api backend only: import the built timeline into the running Resolve now.' },
      },
      required: ['spec'],
      additionalProperties: false,
    },
    timeoutMs: 300_000,
    output: OUTPUT_TOOL,
    async execute(args, exec) {
      try {
        if (!args.spec || typeof args.spec !== 'object') {
          return json({ ok: false, error: 'spec must be an object. Call resolve_help for the shape.' })
        }
        const info = await detect(options)
        const spec = { ...args.spec }
        if (args.name) spec.name = args.name
        if (args.fps) spec.fps = args.fps

        const outputDir = args.outputDir ?? path.join(sessionDir(ctx, exec), 'resolve-edits')
        const manifest = await buildEdit(spec, {
          outputDir,
          pythonPath: options.pythonPath,
          baseDir: outputDir,
          backend: info.backend,
        })

        if (args.apply && info.backend === 'api') {
          try {
            const bridge = await getBridge(options)
            const imported = await bridge.request('import_fcpxml', {
              path: manifest.timelinePath,
              timelineName: manifest.name,
            })
            manifest.imported = imported
            manifest.backend = 'api'
            manifest.next = ['已直接导入当前 Resolve 工程：' + imported.timeline]
          } catch (error) {
            manifest.importError = error.message
            manifest.next = ['导入失败，但 .fcpxml 已生成，可手动导入：' + manifest.timelinePath]
          }
        } else if (args.apply) {
          manifest.next = [
            '当前是 file 后端（免费版无脚本 API），.fcpxml 已生成。',
            '在 Resolve 里：文件 › 导入 › 时间线… 选择 ' + manifest.timelinePath,
          ]
        }
        return json(manifest)
      } catch (error) {
        return fail(error, { hint: 'Check file paths and durations. Call resolve_help for the spec reference.' })
      }
    },
  })

  ctx.tools.register({
    name: 'resolve_preview',
    description:
      'Render frames of a built edit WITHOUT Resolve: ffmpeg pulls each source frame and the title overlays are ' +
      'composited on top, so you can actually see what the timeline looks like and iterate. Produces individual PNGs ' +
      'plus a labelled contact sheet. This is the free-edition stand-in for resolve_frame — use it after resolve_build ' +
      'to check titles, framing and timing before importing.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'The outputDir you passed to resolve_build (holds manifest.json).' },
        frames: {
          type: 'array',
          items: { type: 'number' },
          description: 'Explicit frame numbers to render. Omit to pick representative frames automatically.',
        },
        count: { type: 'number', description: 'How many frames to auto-pick. Default 4.' },
        columns: { type: 'number', description: 'Contact sheet columns. Default 2.' },
        outputDir: { type: 'string', description: 'Where to write previews. Defaults to <dir>/preview.' },
      },
      additionalProperties: false,
    },
    timeoutMs: 240_000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const { image, ...rest } = value
        const blocks = [{ type: 'text', text: json(rest) }]
        if (image && typeof image.attachmentId === 'string' && image.attachmentId.length > 0) {
          blocks.push({ type: 'image', attachment: { ...image } })
        }
        return blocks
      },
    },
    async execute(args, exec) {
      try {
        const dir = args.dir ?? path.join(sessionDir(ctx, exec), 'resolve-edits')
        const result = await renderPreview({
          dir,
          frames: args.frames,
          count: args.count,
          columns: args.columns,
          outDir: args.outputDir,
          pythonPath: options.pythonPath,
        })
        const image = await attachImage(ctx, result.sheet)
        if (image !== null) return { ...result, image }
        return {
          ...result,
          imageNote: 'The contact sheet could not be attached as an image block; open the "sheet" path with read_image to see it.',
        }
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error), hint: 'Run resolve_build first, or pass dir=<its outputDir>.' }
      }
    },
  })

  ctx.tools.register({
    name: 'resolve_import',
    description:
      'Import an existing .fcpxml (or .drt/.otio) timeline into the running Resolve project. API backend only — ' +
      'it needs Resolve Studio with external scripting enabled.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the timeline file.' },
        timelineName: { type: 'string', description: 'Optional name for the imported timeline.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    timeoutMs: 180_000,
    output: OUTPUT_TOOL,
    async execute(args) {
      try {
        const bridge = await getBridge(options)
        return json({ ok: true, ...(await bridge.request('import_fcpxml', args)) })
      } catch (error) {
        return fail(error, { fallback: '没有直连能力时，请在 Resolve 里手动「文件 › 导入 › 时间线」。' })
      }
    },
  })

  ctx.tools.register({
    name: 'resolve_state',
    description:
      'Read the live state of the running Resolve: version, page, project, current timeline and every clip on ' +
      'every track with start frame and duration. API backend only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 60_000,
    output: OUTPUT_TOOL,
    async execute() {
      try {
        const bridge = await getBridge(options)
        const status = await bridge.request('status', {})
        let timeline = null
        try {
          timeline = await bridge.request('timeline', {})
        } catch {
          timeline = null
        }
        return json({ ok: true, status, timeline })
      } catch (error) {
        return fail(error)
      }
    },
  })

  ctx.tools.register({
    name: 'resolve_frame',
    description:
      'Export one frame of the current timeline as a PNG so you can actually look at the result and iterate. ' +
      'Returns the image path. API backend only (Resolve Studio).',
    parameters: {
      type: 'object',
      properties: {
        offset: { type: 'number', description: 'Frame offset from the timeline start. Default 0.' },
        path: { type: 'string', description: 'Output PNG path. Defaults to <session dir>/resolve-frames/frame-<offset>.png.' },
        maxDimension: { type: 'number', description: 'Cap the longer edge in pixels. 0 = full size (default).' },
      },
      additionalProperties: false,
    },
    timeoutMs: 120_000,
    output: OUTPUT_TOOL,
    async execute(args, exec) {
      try {
        const bridge = await getBridge(options)
        const offset = Math.max(0, Math.round(Number(args.offset ?? 0)))
        const out = args.path ?? path.join(sessionDir(ctx, exec), 'resolve-frames', `frame-${offset}.png`)
        const result = await bridge.request('export_frame', {
          offset,
          path: out,
          maxDimension: args.maxDimension ?? 0,
        })
        return json({ ok: true, ...result })
      } catch (error) {
        return fail(error)
      }
    },
  })

  ctx.tools.register({
    name: 'resolve_render',
    description:
      'Render the current timeline in the running Resolve to a target folder and return the job id. API backend only.',
    parameters: {
      type: 'object',
      properties: {
        targetDir: { type: 'string', description: 'Absolute output folder. Defaults to <session dir>/resolve-renders.' },
        customName: { type: 'string', description: 'Optional output file base name.' },
        wait: { type: 'boolean', description: 'Poll until the job finishes (default false).' },
      },
      additionalProperties: false,
    },
    timeoutMs: 600_000,
    output: OUTPUT_TOOL,
    async execute(args, exec) {
      try {
        const bridge = await getBridge(options)
        const targetDir = args.targetDir ?? path.join(sessionDir(ctx, exec), 'resolve-renders')
        const started = await bridge.request('render', { targetDir, customName: args.customName })
        if (!args.wait) return json({ ok: true, ...started })
        const deadline = Date.now() + 9 * 60_000
        let status = null
        while (Date.now() < deadline) {
          status = await bridge.request('render_status', { jobId: started.jobId })
          const job = status?.job?.JobStatus ?? status?.job?.status
          if (job && /complete|failed|cancelled/i.test(String(job))) break
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
        return json({ ok: true, ...started, status })
      } catch (error) {
        return fail(error)
      }
    },
  })

  ctx.tools.register({
    name: 'resolve_py',
    description:
      'Escape hatch: run Python against the live Resolve API with `resolve`, `project`, `timeline` and `mediapool` ' +
      'already in scope. Use it for anything the other tools do not cover (Fusion nodes, color, metadata, ' +
      'transitions). API backend only.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Python source. An expression returns its value; otherwise set `result`.',
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
    timeoutMs: 180_000,
    output: OUTPUT_TOOL,
    async execute(args) {
      try {
        const bridge = await getBridge(options)
        return json({ ok: true, ...(await bridge.request('py', { code: args.code }, 120_000)) })
      } catch (error) {
        return fail(error)
      }
    },
  })

  ctx.tools.register({
    name: 'resolve_live',
    description:
      'Queue one operation for the in-app bridge running inside Resolve and wait for its result. This is the free-edition ' +
      'path to live control: the script runs inside Resolve (Workspace > Scripts), so it needs no external scripting port. ' +
      'Operations: status, import_fcpxml, timeline, export_frame, render, py. If nothing answers, ask the user to click ' +
      'Workspace > Scripts > Utility > dsh_resolve_bridge once; the panel then drains the queue continuously.',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['status', 'import_fcpxml', 'timeline', 'export_frame', 'render', 'py'],
          description: 'Operation name.',
        },
        args: {
          type: 'object',
          additionalProperties: true,
          description:
            'Operation arguments. import_fcpxml: {path, timelineName}. export_frame: {offset, path}. render: {targetDir, customName}. py: {code}.',
        },
        waitMs: { type: 'number', description: 'How long to wait for the bridge to answer. Default 12000.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    timeoutMs: 120_000,
    output: OUTPUT_TOOL,
    async execute(args) {
      try {
        const installed = existsSync(path.join(scriptsDir(), BRIDGE_FILENAME))
        const pending = await queueDepth()
        const { id, resultPath } = await enqueue(args.op, args.args ?? {})
        const result = await waitForResult(resultPath, Math.max(2_000, Number(args.waitMs ?? 12_000)))
        if (!result) {
          return json({
            ok: false,
            queued: id,
            error: '应用内桥没有响应：它没在运行。',
            hint: installed ? clickHint() : '桥脚本还没放进 Resolve 的脚本目录。',
            state: await readState(),
          })
        }
        return json({ ok: result.ok !== false, queued: id, ...result })
      } catch (error) {
        return fail(error)
      }
    },
  })

  ctx.tools.register({
    name: 'resolve_live_status',
    description:
      'Report whether the in-app bridge inside Resolve is installed, alive, and what it last saw (version, project, ' +
      'timeline). Use it to decide between the file backend and live control.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 30_000,
    output: OUTPUT_TOOL,
    async execute() {
      const scriptPath = path.join(scriptsDir(), BRIDGE_FILENAME)
      const installed = existsSync(scriptPath)
      const state = await readState()
      const ageMs = state?.time ? Date.now() - new Date(state.time.replace(' ', 'T')).getTime() : null
      return json({
        ok: true,
        installed,
        scriptPath: installed ? scriptPath : null,
        pendingJobs: await queueDepth(),
        lastRun: state?.time ?? null,
        lastRunAgeSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
        bridgeReport: state,
        next: installed
          ? '在 Resolve：工作区 › 脚本 › Utility › dsh_resolve_bridge，打开后队列会自动消费。'
          : '先让插件把 inapp_bridge.py 放进 Resolve 的脚本目录（重装 bundle 即可）。',
      })
    },
  })

  ctx.on('dispose', () => resetBridge())
}

export { tcpOpen }
