import { startHub } from './startHub'
import { heapStats } from 'bun:jsc'
import { writeFileSync } from 'node:fs'

async function main() {
    const hub = await startHub()
    const diagnosticPath = process.env.HAPI_RUNTIME_DIAGNOSTICS
    if (diagnosticPath) {
        const samples: unknown[] = []
        setInterval(() => {
            const heap = heapStats()
            samples.push({ time: Date.now(), ...process.memoryUsage(),
                heapSize: heap.heapSize, heapCapacity: heap.heapCapacity,
                objects: heap.objectCount, protectedObjects: heap.protectedObjectCount,
                types: heap.objectTypeCounts })
            if (samples.length > 60) samples.shift()
            try { writeFileSync(diagnosticPath, JSON.stringify(samples), { mode: 0o600 }) } catch {}
        }, 3000).unref()
    }

    const shutdown = async () => {
        console.log('\nShutting down...')
        await hub.stop()
        process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    // Keep process running
    await new Promise(() => {})
}

main().catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
})
