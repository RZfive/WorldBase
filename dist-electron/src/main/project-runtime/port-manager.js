import net from 'node:net';
/**
 * PortManager — 端口分配与管理
 * 为每个子项目分配唯一的端口号
 */
export class PortManager {
    allocated = new Map();
    basePort = 3100;
    maxPort = 3999;
    /**
     * Allocate a port for a project.
     */
    async allocate(projectId, preferredPort) {
        // If already allocated, return existing
        if (this.allocated.has(projectId)) {
            return this.allocated.get(projectId);
        }
        // Try preferred port first
        if (preferredPort && await this._isPortAvailable(preferredPort)) {
            this.allocated.set(projectId, preferredPort);
            return preferredPort;
        }
        // Find next available port
        const usedPorts = new Set(this.allocated.values());
        for (let port = this.basePort; port <= this.maxPort; port++) {
            if (!usedPorts.has(port) && await this._isPortAvailable(port)) {
                this.allocated.set(projectId, port);
                return port;
            }
        }
        throw new Error('No available ports in range');
    }
    /**
     * Release a port allocated to a project.
     */
    release(projectId) {
        this.allocated.delete(projectId);
    }
    /**
     * Get the port allocated to a project.
     */
    getPort(projectId) {
        return this.allocated.get(projectId) || null;
    }
    /**
     * Check if a port is available.
     */
    _isPortAvailable(port) {
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.once('listening', () => {
                server.close(() => resolve(true));
            });
            server.listen(port, '127.0.0.1');
        });
    }
}
