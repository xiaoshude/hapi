// Real socket client + real process signals; used only by the isolated test Hub.
import { ApiClient } from '@/api/api'
const { createRunnerLifecycle } = await import(process.env.HAPI_LIFECYCLE_TEST_MODULE || './runnerLifecycle')

const api = await ApiClient.create()
const info = await api.getOrCreateSession({
    tag: `lifecycle-signal-${process.pid}`,
    metadata: { path: '/tmp', host: 'regression-test', lifecycleState: 'running', codexSessionId: 'retained-native-id' },
    state: null
})
const session = api.sessionSyncClient(info)
const lifecycle = createRunnerLifecycle({ session, logTag: 'signal-regression' })
lifecycle.registerProcessHandlers()
await session.flush({ timeoutMs: 5000 })
session.keepAlive(false, 'remote')
await session.flush({ timeoutMs: 5000 })
process.stdout.write(`${JSON.stringify({ sessionId: info.id })}\n`)
setInterval(() => session.keepAlive(false, 'remote'), 1000)
