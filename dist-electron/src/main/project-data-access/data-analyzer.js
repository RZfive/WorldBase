/**
 * Validate that a SQL identifier (table/column name) is safe.
 * Only allows alphanumeric characters and underscores.
 */
function validateIdentifier(name) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        throw new Error(`Invalid SQL identifier: ${name}`);
    }
    return name;
}
/**
 * DataAnalyzer — 数据分析工具
 * 提供统计、聚合、趋势分析等功能
 */
export class DataAnalyzer {
    /**
     * Run an analysis on project data.
     */
    async analyze(dataAccess, projectId, analysisType, options = {}) {
        switch (analysisType) {
            case 'summary':
                return this._analyzeSummary(dataAccess, projectId);
            case 'trend':
                return this._analyzeTrend(dataAccess, projectId, options);
            case 'distribution':
                return this._analyzeDistribution(dataAccess, projectId, options);
            case 'comparison':
                return this._analyzeComparison(dataAccess, projectId, options);
            default:
                throw new Error(`Unknown analysis type: ${analysisType}`);
        }
    }
    /**
     * Summary analysis — basic statistics for each table.
     */
    async _analyzeSummary(dataAccess, projectId) {
        const summary = await dataAccess.getDataSummary(projectId);
        return {
            ...summary,
            type: 'summary',
            projectId
        };
    }
    /**
     * Trend analysis — analyze data changes over time.
     */
    async _analyzeTrend(dataAccess, projectId, options) {
        const { table, dateColumn, valueColumn, groupBy } = options;
        if (!table || !dateColumn || !valueColumn) {
            throw new Error('Trend analysis requires: table, dateColumn, valueColumn');
        }
        validateIdentifier(table);
        validateIdentifier(dateColumn);
        validateIdentifier(valueColumn);
        if (groupBy)
            validateIdentifier(groupBy);
        let sql = `SELECT "${dateColumn}", `;
        if (groupBy) {
            sql += `"${groupBy}", `;
        }
        sql += `SUM("${valueColumn}") as total, AVG("${valueColumn}") as average, COUNT(*) as count `;
        sql += `FROM "${table}" `;
        sql += `GROUP BY "${dateColumn}"`;
        if (groupBy) {
            sql += `, "${groupBy}"`;
        }
        sql += ` ORDER BY "${dateColumn}" ASC`;
        const rows = await dataAccess.queryDatabase(projectId, sql);
        return {
            type: 'trend',
            projectId,
            table,
            dateColumn,
            valueColumn,
            data: rows
        };
    }
    /**
     * Distribution analysis — analyze value distribution.
     */
    async _analyzeDistribution(dataAccess, projectId, options) {
        const { table, column } = options;
        if (!table || !column) {
            throw new Error('Distribution analysis requires: table, column');
        }
        validateIdentifier(table);
        validateIdentifier(column);
        const sql = `SELECT "${column}", COUNT(*) as count FROM "${table}" GROUP BY "${column}" ORDER BY count DESC`;
        const rows = await dataAccess.queryDatabase(projectId, sql);
        const total = rows.reduce((sum, r) => sum + r.count, 0);
        const data = rows.map(r => ({
            value: r[column],
            count: r.count,
            percentage: total > 0 ? ((r.count / total) * 100).toFixed(1) + '%' : '0%'
        }));
        return {
            type: 'distribution',
            projectId,
            table,
            column,
            total,
            data
        };
    }
    /**
     * Comparison analysis — compare metrics across different dimensions.
     */
    async _analyzeComparison(dataAccess, projectId, options) {
        const { table, groupColumn, valueColumn, aggregation = 'SUM' } = options;
        if (!table || !groupColumn || !valueColumn) {
            throw new Error('Comparison analysis requires: table, groupColumn, valueColumn');
        }
        validateIdentifier(table);
        validateIdentifier(groupColumn);
        validateIdentifier(valueColumn);
        const validAggregations = ['SUM', 'AVG', 'COUNT', 'MIN', 'MAX'];
        const agg = validAggregations.includes(aggregation.toUpperCase())
            ? aggregation.toUpperCase()
            : 'SUM';
        const sql = `SELECT "${groupColumn}", ${agg}("${valueColumn}") as value FROM "${table}" GROUP BY "${groupColumn}" ORDER BY value DESC`;
        const rows = await dataAccess.queryDatabase(projectId, sql);
        return {
            type: 'comparison',
            projectId,
            table,
            groupColumn,
            valueColumn,
            aggregation: agg,
            data: rows
        };
    }
}
