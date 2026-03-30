/**
 * Tool: query_project_database — 查询指定项目的数据库
 */
export function toolQueryDb(services) {
    return {
        definition: {
            name: 'query_project_database',
            description: '对指定项目的数据库执行只读 SQL 查询。仅支持 SELECT 语句。用于分析项目数据。',
            parameters: {
                type: 'object',
                properties: {
                    project_id: {
                        type: 'string',
                        description: '项目 ID'
                    },
                    sql: {
                        type: 'string',
                        description: 'SELECT 查询语句'
                    }
                },
                required: ['project_id', 'sql']
            }
        },
        handler: async (args) => {
            const { project_id, sql } = args;
            const rows = await services.dataAccess.queryDatabase(project_id, sql);
            return { rowCount: rows.length, rows };
        }
    };
}
