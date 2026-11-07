import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentRequest, ToolName, AgentMetadata, LocalAgentHandler } from '../shared/protocol.js'
import { runCodingTool, setCommandExecutionEnabled } from './coding-tools.js'
import keytar from 'keytar'

async function getConfig() {
  const get = async (key: string, fallback?: string) => {
    const value = await keytar.getPassword('chatgpt-mcp', key)
    if (value !== null) return value
    return fallback
  }
  return {
    serverUrl: process.env.SERVER_URL || (await get('SERVER_URL')) || 'ws://127.0.0.1:8787/agent',
    agentToken: process.env.AGENT_TOKEN || await get('AGENT_TOKEN'),
    agentId: process.env.AGENT_ID || (await get('AGENT_ID')) || os.hostname(),
    allowCommandExecution: process.env.ALLOW_COMMAND_EXECUTION || await get('ALLOW_COMMAND_EXECUTION')
  }
}

export type AgentRuntime = {
  agentId: string
  metadata: AgentMetadata
  handleRequest: LocalAgentHandler
  logStartup: (transport: string) => void
}

export async function createAgentRuntime(): Promise<AgentRuntime> {
  const config = await getConfig()
  const execFileAsync = promisify(execFile)
  const SERVER_URL = config.serverUrl
  const AGENT_TOKEN = config.agentToken
  const AGENT_ID = config.agentId
  const AGENT_VERSION = '0.2.0'
  const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES ?? 1_000_000)
  const ALLOW_COMMAND_EXECUTION = config.allowCommandExecution === 'true'
  setCommandExecutionEnabled(ALLOW_COMMAND_EXECUTION)
  const IS_WINDOWS = process.platform === 'win32'
  const IS_LINUX = process.platform === 'linux'
  if (!AGENT_TOKEN) throw new Error('AGENT_TOKEN must be set')
  const AGENT_WORKSPACE = path.resolve(process.env.AGENT_WORKSPACE ?? (IS_LINUX ? os.homedir() : 'D:\\mcp-agent-workspace'))

  function assertAllowed(target: string) {
    const resolved = path.resolve(target)
    const a = IS_WINDOWS ? resolved.toLowerCase() : resolved
    const b = IS_WINDOWS ? AGENT_WORKSPACE.toLowerCase() : AGENT_WORKSPACE
    if (!(a === b || a.startsWith(b + path.sep))) throw new Error(`Path is outside agent workspace: ${resolved}`)
    return resolved
  }
  function logCommand(command: string, cwd?: string) {
    console.log(`[agent] $ ${command}${cwd ? ` (cwd: ${cwd})` : ''}`)
  }

  async function run(request: AgentRequest): Promise<unknown> {
    switch (request.tool as ToolName) {
      case 'read_file': {
        const file = assertAllowed(String(request.args.path))
        const bytes = await fs.readFile(file)
        return { path: file, content: bytes.toString('utf8'), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
      }
      case 'write_file': {
        const file = assertAllowed(String(request.args.path))
        const content = String(request.args.content)
        const expectedSha256 = typeof request.args.expectedSha256 === 'string' ? request.args.expectedSha256.toLowerCase() : undefined
        let current: Buffer | undefined
        try { current = await fs.readFile(file) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
        if (current && !expectedSha256) throw new Error('expectedSha256 is required when overwriting an existing file; read the file first')
        if (!current && expectedSha256) throw new Error('File changed since it was read: file no longer exists')
        const beforeSha256 = current ? crypto.createHash('sha256').update(current).digest('hex') : null
        if (expectedSha256 && beforeSha256 !== expectedSha256) throw new Error(`File changed since it was read: expected sha256 ${expectedSha256}, current sha256 ${beforeSha256}`)
        const temporary = path.join(path.dirname(file), `.${path.basename(file)}.mcp-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
        try {
          await fs.writeFile(temporary, content, 'utf8')
          const latest = await fs.readFile(file).catch((error: any) => error.code === 'ENOENT' ? undefined : Promise.reject(error))
          const latestSha256 = latest ? crypto.createHash('sha256').update(latest).digest('hex') : null
          if (latestSha256 !== beforeSha256) throw new Error('File changed while the write was being prepared; refusing to overwrite it')
          await fs.rename(temporary, file)
        } finally { await fs.rm(temporary, { force: true }) }
        const after = Buffer.from(content, 'utf8')
        return { ok: true, path: file, sha256Before: beforeSha256, sha256After: crypto.createHash('sha256').update(after).digest('hex'), bytesAfter: after.length }
      }
      case 'list_directory': {
        const dir = assertAllowed(String(request.args.path))
        const entries = await fs.readdir(dir, { withFileTypes: true })
        return entries.map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
      }
      case 'execute_powershell': {
        if (!IS_WINDOWS) throw new Error('execute_powershell is only available on Windows; use execute_bash on Linux.')
        if (!ALLOW_COMMAND_EXECUTION) throw new Error('PowerShell execution is disabled. Set ALLOW_COMMAND_EXECUTION=true on the Windows agent to enable it.')
        const command = String(request.args.command)
        logCommand(`pwsh.exe -NoLogo -NoProfile -NonInteractive -Command ${command}`)
        try {
          const result = await execFileAsync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES })
          return { stdout: result.stdout, stderr: result.stderr, code: 0 }
        } catch (error: any) {
          return { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message ?? error), code: typeof error.status === 'number' ? error.status : 1 }
        }
      }
      case 'execute_bash': {
        if (!IS_LINUX) throw new Error('execute_bash is only available on Linux.')
        if (!ALLOW_COMMAND_EXECUTION) throw new Error('Bash execution is disabled. Set ALLOW_COMMAND_EXECUTION=true on the Linux agent to enable it.')
        const command = String(request.args.command)
        logCommand(`bash -lc ${JSON.stringify(command)}`)
        try {
          const result = await execFileAsync('/bin/bash', ['-lc', command], { maxBuffer: MAX_OUTPUT_BYTES })
          return { stdout: result.stdout, stderr: result.stderr, code: 0 }
        } catch (error: any) {
          return { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message ?? error), code: typeof error.status === 'number' ? error.status : 1 }
        }
      }
      case 'get_system_info':
        return { hostname: os.hostname(), platform: process.platform, arch: process.arch, release: os.release(), workspace: AGENT_WORKSPACE, commandExecutionEnabled: ALLOW_COMMAND_EXECUTION }
      case 'get_agent_capabilities':
        return {
          screenshot: { supported: false, detail: 'Probe via coding tools' },
          cdp9222: { connected: false, detail: 'Probe via coding tools' },
          powershell: { available: IS_WINDOWS, enabled: IS_WINDOWS && ALLOW_COMMAND_EXECUTION, detail: IS_WINDOWS ? 'Windows' : 'N/A' },
          bash: { available: IS_LINUX, enabled: IS_LINUX && ALLOW_COMMAND_EXECUTION, detail: IS_LINUX ? 'Linux' : 'N/A' },
          adb: { available: false, connected: false, devices: [], detail: 'Not probed in embedded core' },
        }
      default:
        return runCodingTool(request.tool, request.args, AGENT_WORKSPACE, logCommand)
    }
  }

  const metadata: AgentMetadata = {
    hostname: os.hostname(),
    platform: process.platform,
    username: os.userInfo().username,
    workspace: AGENT_WORKSPACE,
    version: AGENT_VERSION
  }

  const handleRequest: LocalAgentHandler = async (request) => {
    if (request.type !== 'request' || !request.id || !request.tool) throw new Error('invalid agent request')
    const time = `${new Date().getHours().toString().padStart(2, '0')}:${new Date().getMinutes().toString().padStart(2, '0')}`
    console.log(`[agent][${time}] tool=${request.tool} requestId=${request.id} started`)
    try {
      const result = await run(request)
      console.log(`[agent][${time}] tool=${request.tool} requestId=${request.id} response=ok transport=direct`)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[agent][${time}] tool=${request.tool} requestId=${request.id} FAILED: ${message}`)
      throw error instanceof Error ? error : new Error(message)
    }
  }

  ;(handleRequest as any)._wsContext = { SERVER_URL, AGENT_TOKEN, AGENT_ID, run }

  function logStartup(transport: string) {
    console.log(`[agent] mode: ${IS_WINDOWS ? 'windows/powershell' : IS_LINUX ? 'linux/bash' : process.platform} transport=${transport}`)
    console.log(`[agent] workspace: ${AGENT_WORKSPACE}`)
    console.log(`[agent] command execution: ${ALLOW_COMMAND_EXECUTION ? 'ENABLED' : 'DISABLED'}`)
  }

  return { agentId: AGENT_ID, metadata, handleRequest, logStartup }
}
