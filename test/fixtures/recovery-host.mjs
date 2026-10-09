import { createHost } from '../../dist/index.js'
const config = JSON.parse(process.argv[2])
const host = await createHost(config)
const view = () => ({ jobs: host.ctx.subagent.jobs(), sessions: host.ctx.sessions.list() })
process.send?.({ ready: true, ...view() })
process.on('message', async (m) => {
  if (m === 'view') process.send?.(view())
  if (m === 'stop') { await host.dispose(); process.exit(0) }
  if (m?.action === 'spawn') {
    const parent = host.ctx.sessions.create({ title: 'Live parent', projectRoot: config.workspace.root })
    const result = await host.ctx.tools.call('task', { tasks: [{description:'first live worker'},{description:'queued live worker'}], background:true }, {sessionId:parent.id})
    process.send?.({ spawned: true, parentId: parent.id, result })
  }
})
