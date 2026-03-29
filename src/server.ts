import Fastify from 'fastify'

const app = Fastify({ logger: true })

app.get('/health', async () => {
  return {
    ok: true,
    version: '0.1.0',
    vk_connected: false,
    sessions_active: 0,
  }
})

app.post('/sessions', async (_request, reply) => {
  return reply.status(501).send({ error: 'not implemented' })
})

app.patch('/sessions/:id', async (_request, reply) => {
  return reply.status(501).send({ error: 'not implemented' })
})

app.get('/sessions', async () => {
  return { sessions: [] }
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
