import { startWebSocketAgent } from './agent-runtime.js'

// Standalone entry (`npm run agent`): WebSocket client.
// Embedded mode is started explicitly via startLocalAgent from the launcher.
if (process.env.EMBEDDED_AGENT !== '1') {
  startWebSocketAgent().catch(error => {
    console.error('[agent] fatal startup/configuration error:', error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  })
}

process.on('uncaughtException', error => {
  console.error('[agent] uncaught exception:', error.stack ?? error.message)
})
process.on('unhandledRejection', reason => {
  console.error('[agent] unhandled rejection:', reason instanceof Error ? reason.stack ?? reason.message : String(reason))
})

export { startLocalAgent, startWebSocketAgent } from './agent-runtime.js'
