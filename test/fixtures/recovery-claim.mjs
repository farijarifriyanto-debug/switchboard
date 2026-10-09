import { writeFile, link } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
const dir = process.argv[2]
const owner = { host: hostname(), pid: process.pid, token: 'dead-owner' }
await writeFile(path.join(dir, '.recovery.lock'), JSON.stringify(owner))
await writeFile(path.join(dir, '.claim-stage'), JSON.stringify({ ...owner, token: 'dead-claim' }))
await link(path.join(dir, '.claim-stage'), path.join(dir, '.recovery.lock.claim'))
process.send?.('claim-published')
setInterval(() => {}, 1000)
