import { parentPort, workerData } from 'node:worker_threads'
import { ChatHistoryStorage } from './chat-history-storage.js'

const port = parentPort!
const store = new ChatHistoryStorage(workerData.userDataPath)
const methods = new Set(['list', 'get', 'save', 'updateMetadata', 'rename', 'delete'])
port.on('message', ({ id, method, args }) => {
  try {
    if (method === 'close') {
      port.postMessage({ id, result: null })
      port.close()
      return
    }
    if (!methods.has(method)) throw new Error('Unknown chat history method')
    const result = (store[method as keyof ChatHistoryStorage] as (...args: any[]) => unknown).apply(store, args)
    port.postMessage({ id, result })
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
})
