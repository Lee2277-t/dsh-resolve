import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'

/**
 * Client for the in-app bridge (bridge/inapp_bridge.py).
 *
 * The free edition has no external scripting port, so the only way in is a script
 * that runs *inside* Resolve. We hand work to it through a folder queue and read
 * results back. When the bridge's panel is open it drains the queue continuously,
 * so calls feel live; otherwise each batch needs one Workspace > Scripts click.
 */
export function bridgeRoot() {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return path.join(local, 'dsh-resolve')
}

export function scriptsDir() {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Fusion', 'Scripts', 'Utility')
}

/** Resolve's own per-user config root; its presence means Resolve has run here. */
export function resolveConfigRoot() {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'Blackmagic Design', 'DaVinci Resolve')
}

export const BRIDGE_FILENAME = 'dsh_resolve_bridge.py'

export async function ensureQueue() {
  const root = bridgeRoot()
  for (const dir of ['jobs', 'results', 'done']) {
    await fs.mkdir(path.join(root, dir), { recursive: true })
  }
  return root
}

let seq = 0

export async function enqueue(op, args = {}) {
  const root = await ensureQueue()
  const id = `${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const file = path.join(root, 'jobs', `${id}.json`)
  await fs.writeFile(file, JSON.stringify({ id, op, args }, null, 2), 'utf8')
  return { id, resultPath: path.join(root, 'results', `${id}.json`) }
}

/** Wait for the bridge to answer one job. Returns null on timeout. */
export async function waitForResult(resultPath, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(resultPath, 'utf8')
      return JSON.parse(raw)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  return null
}

export async function readState() {
  try {
    const raw = await fs.readFile(path.join(bridgeRoot(), 'state.json'), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function queueDepth() {
  const root = bridgeRoot()
  try {
    const jobs = await fs.readdir(path.join(root, 'jobs'))
    return jobs.filter((f) => f.endsWith('.json')).length
  } catch {
    return 0
  }
}

export function clickHint() {
  return (
    '在 Resolve 里点一次菜单：工作区(Workspace) › 脚本(Scripts) › Utility › ' +
    BRIDGE_FILENAME.replace(/\.py$/, '') +
    '。开一次面板后，后续调用会自动执行，不用再点。'
  )
}
