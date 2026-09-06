import { describe, it, expect } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { z } from 'zod'

describe('process retirement through a real Hub', () => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        it(`${signal} preserves retirement versus user archive intent`, async () => {
            const child = spawn(process.env.HAPI_BUN_EXEC!, [join(import.meta.dirname, 'runnerLifecycle.signal-fixture.ts')], {
                cwd: process.cwd(),
                env: { PATH: process.env.PATH, HOME: process.env.HOME,
                    HAPI_HOME: process.env.HAPI_HOME, HAPI_API_URL: process.env.HAPI_API_URL,
                    HAPI_LIFECYCLE_TEST_MODULE: process.env.HAPI_LIFECYCLE_TEST_MODULE,
                    CLI_API_TOKEN: process.env.CLI_API_TOKEN },
                stdio: ['ignore', 'pipe', 'pipe']
            })
            try {
                const exit = once(child, 'exit')
                let output = ''
                const id = await new Promise<string>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('fixture did not start')), 8000)
                    child.stdout.on('data', chunk => {
                        output += String(chunk)
                        for (const line of output.split('\n')) {
                            if (!line.startsWith('{')) continue
                            try {
                                const parsed = JSON.parse(line)
                                if (parsed.sessionId) { clearTimeout(timer); resolve(parsed.sessionId) }
                            } catch { /* incomplete line */ }
                        }
                    })
                    child.once('error', error => { clearTimeout(timer); reject(error) })
                })
                const db = join(process.env.HAPI_HOME!, 'hapi.db')
                const queuedId = `signal-queued-${child.pid}`
                execFileSync('sqlite3', [db, `INSERT INTO messages (id,session_id,content,created_at,seq,local_id) VALUES ('${queuedId}','${id}','{"role":"user","content":{"type":"text","text":"pending work"}}',${Date.now()},9999,'${queuedId}');`])
                child.kill(signal)
                const [code] = await exit
                expect(code).toBe(0)
                const load = async () => {
                  const response = await fetch(`${process.env.HAPI_API_URL}/cli/sessions/${id}`, {
                    headers: { Authorization: `Bearer ${process.env.CLI_API_TOKEN}` }
                  })
                  return z.object({ session: z.object({ active: z.boolean(), metadata: z.object({
                    codexSessionId: z.string().optional(), lifecycleState: z.string(), archiveReason: z.string().optional()
                  }) }) }).parse(await response.json()).session
                }
                let session = await load()
                const deadline = Date.now() + 36_000
                while (session.active && Date.now() < deadline) {
                    await new Promise(resolve => setTimeout(resolve, 500))
                    session = await load()
                }
                expect(session.active).toBe(false)
                expect(session.metadata.codexSessionId).toBe('retained-native-id')
                expect(session.metadata.lifecycleState).toBe(signal === 'SIGTERM' ? 'running' : 'archived')
                expect(session.metadata.archiveReason).toBe(signal === 'SIGTERM' ? undefined : 'User terminated')
                if (signal === 'SIGTERM') {
                    const invoked = execFileSync('sqlite3', [db, `SELECT invoked_at IS NULL FROM messages WHERE id='${queuedId}';`], { encoding: 'utf8' }).trim()
                    expect(invoked).toBe('1')
                }
            } finally {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill('SIGKILL')
                    await once(child, 'exit')
                }
            }
        }, 45000)
    }
})
