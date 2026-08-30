export type ProjectRuntimeLogType = 'stdout' | 'stderr'

export interface RustProjectLogSink {
  isRunning: () => boolean
  append: (port: number, type: ProjectRuntimeLogType, text: string) => Promise<unknown>
}

export interface TypeScriptProjectLogSink {
  findProjectIdByPort: (port: number) => string | null
  appendExternalLog: (projectId: string, type: ProjectRuntimeLogType, text: string) => void
}

export interface ProjectRuntimeLogRoute {
  port: number
  type: ProjectRuntimeLogType
  text: string
  rustSelected: boolean
  rust: RustProjectLogSink | null
  typeScript: TypeScriptProjectLogSink | null
  onRustAppendError?: (error: unknown) => void
}

/**
 * Route a Chromium application log to the owner of the project runtime.
 * Rust selection is fail-closed: a stopped selected harness never turns a
 * late browser event into a TypeScript RuntimeManager write.
 */
export function forwardProjectRuntimeLog (route: ProjectRuntimeLogRoute): void {
  const rustIsRunning = route.rust?.isRunning() === true
  // Preference persistence happens before a Rust -> TS handoff. Keep using a
  // still-running Rust app-server during that narrow transition window.
  if (route.rustSelected || rustIsRunning) {
    if (!rustIsRunning || !route.rust) return
    void Promise.resolve()
      .then(async () => await route.rust!.append(route.port, route.type, route.text))
      .catch(error => route.onRustAppendError?.(error))
    return
  }

  const projectId = route.typeScript?.findProjectIdByPort(route.port)
  if (!projectId || !route.typeScript) return
  route.typeScript.appendExternalLog(projectId, route.type, route.text)
}
