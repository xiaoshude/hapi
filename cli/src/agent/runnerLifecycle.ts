import type { ApiSessionClient } from '@/api/apiSession'
import type { SessionEndReason } from '@hapi/protocol'
import { logger } from '@/ui/logger'
import { restoreTerminalState } from '@/ui/terminalState'

type RunnerLifecycleOptions = {
    session: ApiSessionClient
    logTag: string
    stopKeepAlive?: () => void
    onBeforeClose?: () => Promise<void> | void
    onAfterClose?: () => Promise<void> | void
}

export type RunnerLifecycle = {
    setExitCode: (code: number) => void
    setArchiveReason: (reason: string) => void
    setSessionEndReason: (reason: SessionEndReason) => void
    hasExplicitSessionEndReason: () => boolean
    markCrash: (error: unknown) => void
    cleanup: () => Promise<void>
    cleanupConfirmed: (options?: { timeoutMs?: number }) => Promise<void>
    cleanupAndExit: (codeOverride?: number) => Promise<void>
    registerProcessHandlers: () => void
}

export function createRunnerLifecycle(options: RunnerLifecycleOptions): RunnerLifecycle {
    let exitCode = 0
    // Process lifetime and conversation lifetime are independent. A signal
    // from an idle reaper or supervisor proves neither user archive intent
    // nor a Hub restart. Only explicit archive/clear or completed runs archive.
    let archiveReason = 'Process terminated'
    let archiveRequested = false
    let sessionEndReason: SessionEndReason = 'terminated'
    let sessionEndReasonExplicit = false
    let cleanupStarted = false
    let cleanupPromise: Promise<void> | null = null
    let confirmedCleanupPrepared = false
    let confirmedCleanupComplete = false

    const logPrefix = `[${options.logTag}]`

    const updateExitMetadata = () => {
        options.session.updateMetadata((currentMetadata) => {
            const at = Date.now()
            const exit = { at, reason: archiveReason }
            if (archiveRequested) {
                return {
                    ...currentMetadata, lifecycleState: 'archived',
                    lifecycleStateSince: at, archivedBy: 'cli', archiveReason,
                    lastProcessExit: exit
                }
            }
            // Never resurrect a row another actor has already archived/deleted.
            const terminal = currentMetadata.lifecycleState === 'archived'
                || currentMetadata.lifecycleState === 'deleted'
            return {
                ...currentMetadata,
                lifecycleState: currentMetadata.lifecycleState || 'running',
                ...(!terminal ? { archivedBy: undefined, archiveReason: undefined } : {}),
                lastProcessExit: exit
            }
        })
    }

    const archiveAndClose = async () => {
        updateExitMetadata()

        // Older Hubs treat session-end as terminal: they consume queued user
        // prompts and the CLI deletes upload files. Retirement must use normal
        // socket expiry instead, preserving both for a later attach.
        if (archiveRequested) options.session.sendSessionDeath(sessionEndReason)
        await options.session.flush({ timeoutMs: 1_000 })
        await options.session.close()
    }

    const cleanup = async () => {
        if (cleanupPromise) {
            return cleanupPromise
        }

        cleanupStarted = true
        cleanupPromise = (async () => {
            logger.debug(`${logPrefix} Cleanup start`)
            restoreTerminalState()

            try {
                options.stopKeepAlive?.()
                await options.onBeforeClose?.()
                await archiveAndClose()
                logger.debug(`${logPrefix} Cleanup complete`)
            } finally {
                try {
                    await options.onAfterClose?.()
                } catch (error) {
                    logger.debug(`${logPrefix} Error during post-cleanup:`, error)
                }
            }
        })()

        return cleanupPromise
    }

    const cleanupConfirmed = async (confirmedOptions?: { timeoutMs?: number }) => {
        if (confirmedCleanupComplete) {
            return
        }
        cleanupStarted = true
        if (!confirmedCleanupPrepared) {
            logger.debug(`${logPrefix} Confirmed cleanup start`)
            restoreTerminalState()
            options.stopKeepAlive?.()
            await options.onBeforeClose?.()
            updateExitMetadata()
            if (archiveRequested) options.session.sendSessionDeath(sessionEndReason)
            confirmedCleanupPrepared = true
        }

        const confirmed = await options.session.flush({ timeoutMs: confirmedOptions?.timeoutMs ?? 5_000 })
        if (!confirmed) {
            throw Object.assign(new Error(`${logPrefix} Timed out confirming session archive`), { code: 'ETIMEDOUT' })
        }

        await options.session.close()
        confirmedCleanupComplete = true
        try {
            await options.onAfterClose?.()
        } catch (error) {
            logger.debug(`${logPrefix} Error during post-cleanup:`, error)
        }
        logger.debug(`${logPrefix} Confirmed cleanup complete`)
    }

    const cleanupAndExit = async (codeOverride?: number) => {
        if (codeOverride !== undefined) {
            exitCode = codeOverride
        }

        try {
            await cleanup()
            process.exit(exitCode)
        } catch (error) {
            logger.debug(`${logPrefix} Error during cleanup:`, error)
            process.exit(1)
        }
    }

    const setExitCode = (code: number) => {
        exitCode = code
    }

    const setArchiveReason = (reason: string) => {
        archiveReason = reason
        archiveRequested = true
    }

    const setSessionEndReason = (reason: SessionEndReason) => {
        sessionEndReason = reason
        sessionEndReasonExplicit = true
        if (reason === 'completed' && !archiveRequested) {
            archiveReason = 'Session completed'
            archiveRequested = true
        }
    }

    const hasExplicitSessionEndReason = () => sessionEndReasonExplicit

    const markCrash = (error: unknown) => {
        logger.debug(`${logPrefix} Unhandled error:`, error)
        exitCode = 1
        archiveReason = 'Session crashed'
        sessionEndReason = 'error'
    }

    const registerProcessHandlers = () => {
        // SIGTERM retires this process; it does not archive the conversation.
        process.on('SIGTERM', () => {
            void cleanupAndExit()
        })

        // Ctrl-C in a local terminal is genuine user intent — keep the
        // pre-#914 label so the audit trail still shows it.
        process.on('SIGINT', () => {
            setArchiveReason('User terminated')
            void cleanupAndExit()
        })

        process.on('uncaughtException', (error) => {
            markCrash(error)
            void cleanupAndExit(1)
        })

        process.on('unhandledRejection', (reason) => {
            markCrash(reason)
            void cleanupAndExit(1)
        })
    }

    return {
        setExitCode,
        setArchiveReason,
        setSessionEndReason,
        hasExplicitSessionEndReason,
        markCrash,
        cleanup,
        cleanupConfirmed,
        cleanupAndExit,
        registerProcessHandlers
    }
}

export function setControlledByUser(session: ApiSessionClient, mode: 'local' | 'remote' | 'pty'): void {
    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: mode === 'local',
        // Persist the launch mode so reopen/resume can restore it. 'pty' is an
        // immutable launch identity (the web gates the agent-terminal toggle on
        // it), so once set it must survive later local/remote collaboration-mode
        // changes — otherwise a pty→local→pty handoff reports external mode
        // 'remote' and would rewrite it, hiding the terminal toggle for a session
        // whose PTY is still running.
        startingMode: currentState.startingMode === 'pty' ? 'pty' : mode
    }))
    // Also surface it in metadata so the web can gate the agent-terminal toggle
    // (only PTY sessions have an agent PTY to view).
    session.updateMetadata((metadata) => ({
        ...metadata,
        startingMode: metadata.startingMode === 'pty' ? 'pty' : mode
    }))
}

export function createModeChangeHandler(session: ApiSessionClient): (mode: 'local' | 'remote') => void {
    return (mode) => {
        session.sendSessionEvent({ type: 'switch', mode })
        setControlledByUser(session, mode)
    }
}
