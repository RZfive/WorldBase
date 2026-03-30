/**
 * Tool: list_projects — 列出所有项目及状态
 */
export function toolListProjects(services) {
    return {
        definition: {
            name: 'list_projects',
            description: '列出所有已创建项目的列表及其运行状态。',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        },
        handler: async () => {
            const projects = await services.projectFS.listProjects();
            // Enrich with runtime status
            const enriched = projects.map(project => {
                const status = services.runtimeManager.getStatus(project.id);
                return {
                    ...project,
                    runtime: status
                };
            });
            return { projects: enriched };
        }
    };
}
