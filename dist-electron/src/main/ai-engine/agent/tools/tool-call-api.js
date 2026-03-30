/**
 * Tool: call_project_api — 调用指定项目的后端 API
 */
export function toolCallApi(services) {
    return {
        definition: {
            name: 'call_project_api',
            description: '调用指定项目正在运行的后端 HTTP API。用于测试接口或获取运行时数据。',
            parameters: {
                type: 'object',
                properties: {
                    project_id: {
                        type: 'string',
                        description: '项目 ID'
                    },
                    method: {
                        type: 'string',
                        enum: ['GET', 'POST', 'PUT', 'DELETE'],
                        description: 'HTTP 方法'
                    },
                    path: {
                        type: 'string',
                        description: 'API 路径，如 /api/records'
                    },
                    body: {
                        type: 'object',
                        description: '请求体 (POST/PUT 时使用)'
                    }
                },
                required: ['project_id', 'method', 'path']
            }
        },
        handler: async (args) => {
            const { project_id, method, path, body } = args;
            return services.apiClient.call(project_id, method, path, body ?? null);
        }
    };
}
