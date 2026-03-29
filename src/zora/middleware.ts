/**
 * vk-bridge Zora middleware
 *
 * Wraps a Zora task handler to auto-register sessions with vk-bridge.
 * Non-blocking: if the bridge is down, the task runs normally.
 *
 * Usage:
 *   import { withVKBridge } from '../path/to/vk-bridge/src/zora/middleware.js'
 *
 *   export const handler = withVKBridge(async (task, ctx) => {
 *     // your task logic
 *   })
 */

const BRIDGE_URL = process.env.VK_BRIDGE_URL ?? 'http://localhost:3334'

export interface ZoraTask {
  id?: string
  projectPath?: string
  branch?: string
  [key: string]: unknown
}

export interface ZoraContext {
  [key: string]: unknown
}

export type ZoraHandler<T extends ZoraTask = ZoraTask, C extends ZoraContext = ZoraContext> =
  (task: T, ctx: C) => Promise<void>

async function registerSession(task: ZoraTask): Promise<string | null> {
  try {
    const res = await fetch(`${BRIDGE_URL}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runtime: 'zora',
        project_path: task.projectPath ?? process.cwd(),
        branch: task.branch ?? 'main'
      }),
      signal: AbortSignal.timeout(3000)
    })
    if (!res.ok) return null
    const data = await res.json() as { session_id?: string }
    return data.session_id ?? null
  } catch {
    return null
  }
}

async function updateSession(
  sessionId: string,
  status: 'done' | 'blocked'
): Promise<void> {
  try {
    await fetch(`${BRIDGE_URL}/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
      signal: AbortSignal.timeout(3000)
    })
  } catch {
    // ignore — bridge may have gone down
  }
}

export function withVKBridge<T extends ZoraTask, C extends ZoraContext>(
  handler: ZoraHandler<T, C>
): ZoraHandler<T, C> {
  return async (task: T, ctx: C): Promise<void> => {
    const sessionId = await registerSession(task)

    try {
      await handler(task, ctx)
      if (sessionId) await updateSession(sessionId, 'done')
    } catch (err) {
      if (sessionId) await updateSession(sessionId, 'blocked')
      throw err
    }
  }
}
