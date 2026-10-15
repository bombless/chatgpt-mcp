import keytar from 'keytar'

const KEYS = [
  'SERVER_URL',
  'AGENT_TOKEN',
  'AGENT_ID',
  'ALLOW_COMMAND_EXECUTION',
]

;(async () => {
  for (const key of KEYS) {
    const value = process.env[key]
    if (value === undefined) continue

    await keytar.setPassword('chatgpt-mcp', key, value)
    console.log(`已保存 ${key}`)
  }
})().catch(error => {
  console.error('保存环境变量失败:', error)
  process.exitCode = 1
})
