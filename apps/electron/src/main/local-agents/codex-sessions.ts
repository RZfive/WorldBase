import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export async function listCodexSessions (executablePath: string, workspaceRoot: string): Promise<string> {
  const child = spawn(executablePath, ['app-server', '--listen', 'stdio://'], {
    cwd: workspaceRoot,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true
  })
  const reader = createInterface({ input: child.stdout })
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null, result?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      reader.close()
      child.stdin.end()
      child.kill()
      if (error) reject(error)
      else resolve(JSON.stringify(result))
    }
    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`)
    const deadline = setTimeout(() => finish(new Error('Codex session listing timed out.')), 8000)
    child.once('error', finish)
    child.stdin.on('error', finish)
    child.once('close', code => finish(new Error(`Codex session listing exited (${code}).`)))
    reader.on('line', line => {
      let response
      try {
        response = JSON.parse(line)
      } catch {
        return
      }
      if (response?.id !== 1 && response?.id !== 2) return
      if (response.error) {
        finish(new Error(String(response.error.message || 'Codex session listing failed.')))
        return
      }
      if (response.id === 2) {
        finish(null, response.result)
        return
      }
      send({ method: 'initialized' })
      send({
        id: 2,
        method: 'thread/list',
        params: {
          cwd: workspaceRoot,
          limit: 100,
          modelProviders: [],
          sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
          sortKey: 'updated_at'
        }
      })
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'worldbase', version: '1' }, capabilities: null } })
  })
}
