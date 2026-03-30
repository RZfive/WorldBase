/**
 * Tool: create_project — 创建新项目
 */
export function toolCreateProject (services) {
  return {
    definition: {
      name: 'create_project',
      description: '根据 AI 生成的代码创建新项目。提供项目名称、类型、文件内容和元数据。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '项目名称 (如: 记账应用)'
          },
          type: {
            type: 'string',
            enum: ['frontend', 'fullstack'],
            description: '项目类型'
          },
          files: {
            type: 'object',
            description: '文件内容映射 {相对路径: 文件内容}'
          },
          meta: {
            type: 'object',
            description: '.world-meta.json 的内容 (运行时配置、API 定义、数据模式等)'
          }
        },
        required: ['name', 'type', 'files']
      }
    },
    handler: async ({ name, type, files, meta = {} }) => {
      // Generate a project ID from the name
      const projectId = 'proj_' + name
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 30) +
        '_' + Date.now().toString(36)

      const fullMeta = {
        name,
        type,
        createdAt: new Date().toISOString(),
        ...meta
      }

      const project = await services.projectFS.createProject(projectId, fullMeta, files)

      return {
        success: true,
        project,
        message: `Project "${name}" created with ID: ${projectId}`
      }
    }
  }
}
