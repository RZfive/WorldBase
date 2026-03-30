import { toolReadFile } from './tool-read-file.js';
import { toolWriteFile } from './tool-write-file.js';
import { toolCallApi } from './tool-call-api.js';
import { toolQueryDb } from './tool-query-db.js';
import { toolRunCommand } from './tool-run-command.js';
import { toolListProjects } from './tool-list-projects.js';
import { toolAnalyzeData } from './tool-analyze-data.js';
import { toolCreateProject } from './tool-create-project.js';
/**
 * Register all tools to the agent.
 */
export function registerAllTools(agent, services) {
    const tools = [
        toolReadFile(services),
        toolWriteFile(services),
        toolCallApi(services),
        toolQueryDb(services),
        toolRunCommand(services),
        toolListProjects(services),
        toolAnalyzeData(services),
        toolCreateProject(services)
    ];
    for (const tool of tools) {
        agent.registerTool(tool.definition.name, tool.definition, tool.handler);
    }
}
