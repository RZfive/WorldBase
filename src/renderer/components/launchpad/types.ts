export interface ProjectRuntime {
  status?: string
  port?: number
}

export interface Project {
  id: string
  name?: string
  type?: string
  runtime?: ProjectRuntime
  [key: string]: unknown
}

export interface LaunchFolder {
  id: string
  name: string
  projectIds: string[]
}

export type LaunchpadGridItem =
  | { kind: 'folder'; data: LaunchFolder }
  | { kind: 'project'; data: Project }
