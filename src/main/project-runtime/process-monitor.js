import net from 'node:net'

/**
 * ProcessMonitor — 进程健康监控
 */
export class ProcessMonitor {
  /**
   * Wait for a port to become available (process is ready).
   * @param {number} port
   * @param {number} timeoutMs
   */
  async waitForReady (port, timeoutMs = 10000) {
    const startTime = Date.now()

    while (Date.now() - startTime < timeoutMs) {
      const isReady = await this._checkPort(port)
      if (isReady) {
        return true
      }
      await this._sleep(500)
    }

    // Timeout — process may still be starting, don't throw
    console.warn(`[ProcessMonitor] Port ${port} not ready after ${timeoutMs}ms, continuing anyway`)
    return false
  }

  /**
   * Check if a port is accepting connections.
   */
  _checkPort (port) {
    return new Promise((resolve) => {
      const socket = new net.Socket()
      socket.setTimeout(1000)

      socket.on('connect', () => {
        socket.destroy()
        resolve(true)
      })

      socket.on('timeout', () => {
        socket.destroy()
        resolve(false)
      })

      socket.on('error', () => {
        resolve(false)
      })

      socket.connect(port, '127.0.0.1')
    })
  }

  _sleep (ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
