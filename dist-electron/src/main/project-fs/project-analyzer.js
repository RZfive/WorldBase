/**
 * ProjectAnalyzer — 分析项目结构和技术栈
 */
export class ProjectAnalyzer {
    /**
     * Analyze a project based on its file tree.
     */
    async analyze(projectId, fileTree, projectFS) {
        const allFiles = this._flattenTree(fileTree);
        const result = {
            projectId,
            type: 'unknown',
            framework: null,
            hasBackend: false,
            hasFrontend: false,
            entryPoints: [],
            routes: [],
            models: [],
            database: null
        };
        // Detect project type by file patterns
        const fileNames = allFiles.map(f => f.path);
        // Check for backend
        if (fileNames.some(f => f.includes('server.js') || f.includes('app.js') || f.includes('index.js'))) {
            result.hasBackend = true;
        }
        if (fileNames.some(f => f.startsWith('backend/'))) {
            result.hasBackend = true;
        }
        // Check for frontend
        if (fileNames.some(f => f.endsWith('.vue') || f.endsWith('.jsx') || f.endsWith('.tsx'))) {
            result.hasFrontend = true;
        }
        if (fileNames.some(f => f.startsWith('frontend/') || f.startsWith('src/'))) {
            result.hasFrontend = true;
        }
        // Determine project type
        if (result.hasBackend && result.hasFrontend) {
            result.type = 'fullstack';
        }
        else if (result.hasBackend) {
            result.type = 'backend';
        }
        else if (result.hasFrontend) {
            result.type = 'frontend';
        }
        // Detect framework from package.json
        try {
            const pkgContent = await projectFS.readFile(projectId, 'package.json');
            const pkg = JSON.parse(pkgContent);
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            if (deps.vue)
                result.framework = 'vue';
            else if (deps.react)
                result.framework = 'react';
            else if (deps.express)
                result.framework = 'express';
            else if (deps.koa)
                result.framework = 'koa';
            else if (deps.fastify)
                result.framework = 'fastify';
        }
        catch {
            // No package.json
        }
        // Find route files
        result.routes = fileNames.filter(f => f.includes('route') || f.includes('router') || f.includes('controller'));
        // Find model files
        result.models = fileNames.filter(f => f.includes('model') || f.includes('schema'));
        // Detect database
        if (fileNames.some(f => f.endsWith('.sqlite') || f.endsWith('.db'))) {
            result.database = 'sqlite';
        }
        // Find entry points
        const entryPatterns = ['server.js', 'app.js', 'index.js', 'main.js'];
        result.entryPoints = fileNames.filter(f => entryPatterns.some(p => f.endsWith(p)));
        return result;
    }
    /**
     * Flatten a file tree into a flat array of file entries.
     */
    _flattenTree(tree, _prefix = '') {
        let files = [];
        for (const item of tree) {
            if (item.type === 'file') {
                files.push({ ...item, path: item.path || item.name });
            }
            if (item.children) {
                files = files.concat(this._flattenTree(item.children, item.path || item.name));
            }
        }
        return files;
    }
}
