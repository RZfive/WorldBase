/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

interface ElectronAPI {
  chat: (messages: Array<{ role: string; content: string }>) => Promise<{ role: string; content: string }>
  listProjects: () => Promise<Array<Record<string, unknown>>>
  getProject: (projectId: string) => Promise<Record<string, unknown>>
  getFileTree: (projectId: string) => Promise<Array<Record<string, unknown>>>
  readFile: (projectId: string, filePath: string) => Promise<string>
  startProject: (projectId: string) => Promise<Record<string, unknown>>
  stopProject: (projectId: string) => Promise<Record<string, unknown>>
  getProjectStatus: (projectId: string) => Promise<Record<string, unknown>>
  queryData: (projectId: string, sql: string) => Promise<Record<string, unknown>>
  getDataSummary: (projectId: string) => Promise<Record<string, unknown>>
  getAISettings: () => Promise<{ apiKey: string; baseUrl: string; model: string }>
  saveAISettings: (config: { apiKey: string; baseUrl: string; model: string }) => Promise<{ success: boolean }>
}

interface Window {
  electronAPI?: ElectronAPI
}
