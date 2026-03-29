import Fastify from 'fastify'
import { SessionRegistry } from './registry/index.js'
import { VKClient } from './vk/client.js'
import { loadConfig } from './config.js'
import { verifySignature, handleWebhook } from './github/webhook.js'

const app = Fastify({ logger: true })
const registry = new SessionRegistry()

interface SessionBody {
  runtime: 'claude_code' | 'gemini' | 'zora' | 'unknown'
  project_path: string
  branch: string
  worktree_path?: string
  pid?: number
}

interface UpdateBody {
  status: 'in_progress' | 'in_review' | 'done' | 'blocked'
}

app.get('/health', async () => {
  const config = loadConfig()
  const client = new VKClient(config.vk_port)
  const vk_connected = await client.isConnected()
  const sessions_active = registry.list().filter(s => s.status === 'in_progress').length

  return {
    ok: true,
    version: '0.1.0',
    vk_connected,
    sessions_active,
  }
})

app.post<{ Body: SessionBody }>('/sessions', async (request, reply) => {
  const body = request.body
  if (!body?.runtime || !body?.project_path || !body?.branch) {
    return reply.status(400).send({ error: 'Missing required fields: runtime, project_path, branch' })
  }

  const session = await registry.register({
    runtime: body.runtime,
    project_path: body.project_path,
    branch: body.branch,
    worktree_path: body.worktree_path,
    pid: body.pid
  })

  return reply.status(200).send({
    session_id: session.id,
    vk_card_id: session.vk_card_id,
    vk_card_simple_id: session.vk_card_simple_id,
    vk_project_id: session.vk_project_id,
    vk_status_ids: session.vk_status_ids
  })
})

app.patch<{ Params: { id: string }; Body: UpdateBody }>('/sessions/:id', async (request, reply) => {
  const { id } = request.params
  const body = request.body

  const existing = registry.get(id)
  if (!existing) {
    return reply.status(404).send({ error: `Session not found: ${id}` })
  }

  const updated = await registry.update(id, { status: body.status })
  return reply.status(200).send(updated)
})

app.get('/sessions', async () => {
  return { sessions: registry.list() }
})

app.get<{ Params: { id: string } }>('/sessions/:id', async (request, reply) => {
  const session = registry.get(request.params.id)
  if (!session) {
    return reply.status(404).send({ error: `Session not found: ${request.params.id}` })
  }
  return session
})

// Webhook endpoint — Fastify needs raw body for HMAC verification
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    done(null, JSON.parse(body as string))
  } catch (err) {
    done(err as Error, undefined)
  }
})

app.post<{ Body: unknown }>('/github/webhook', {
  config: { rawBody: true }
}, async (request, reply) => {
  const eventType = request.headers['x-github-event'] as string | undefined
  const signature = request.headers['x-hub-signature-256'] as string | undefined

  if (!eventType) {
    return reply.status(400).send({ error: 'Missing X-GitHub-Event header' })
  }

  // Verify HMAC signature if secret is configured for this repo
  if (signature) {
    const rawBody = JSON.stringify(request.body)
    const config = loadConfig()
    // Find the matching project by inspecting the payload's repository
    const repoFullName = (request.body as Record<string, { full_name?: string }>)?.repository?.full_name
    if (repoFullName) {
      // Find project config for this repo
      const projectEntry = Object.entries(config.projects).find(
        ([, proj]) => proj.github_repo === repoFullName
      )
      const secret = projectEntry?.[1]?.github_webhook_secret
      if (secret && !verifySignature(rawBody, signature, secret)) {
        return reply.status(401).send({ error: 'Invalid webhook signature' })
      }
    }
  }

  const result = await handleWebhook(eventType, request.body as Record<string, unknown>, registry)
  return reply.status(200).send({ ok: true, result })
})

const start = async () => {
  try {
    await app.listen({ port: 3334, host: '0.0.0.0' })
    console.log('vk-bridge listening on :3334')
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
