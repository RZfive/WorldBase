import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
/**
 * JsonAdapter — JSON 文件数据适配器
 */
export class JsonAdapter {
    /**
     * Read and parse a JSON file.
     */
    async read(filePath) {
        if (!existsSync(filePath)) {
            throw new Error(`JSON file not found: ${filePath}`);
        }
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    }
    /**
     * Write data to a JSON file.
     */
    async write(filePath, data) {
        const content = JSON.stringify(data, null, 2);
        await fs.writeFile(filePath, content, 'utf-8');
    }
    /**
     * Read a JSON file and return filtered/queried results.
     * Supports simple path-based queries using dot notation.
     */
    async query(filePath, queryPath) {
        const data = await this.read(filePath);
        if (!queryPath) {
            return data;
        }
        // Simple dot-notation path traversal
        const parts = queryPath.split('.');
        let current = data;
        for (const part of parts) {
            if (current === null || current === undefined) {
                return null;
            }
            current = current[part];
        }
        return current;
    }
}
