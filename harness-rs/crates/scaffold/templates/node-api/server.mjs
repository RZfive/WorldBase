import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { domain } from "./src/domain/entities.mjs";

const MAX_BODY_BYTES = 1024 * 1024;

function send(response, status, payload) {
  if (status === 204) {
    response.writeHead(204);
    response.end();
    return;
  }
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw httpError(413, "request body exceeds 1 MiB");
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "invalid JSON body");
  }
}

function listInput(url) {
  const limitValue = Number(url.searchParams.get("limit") ?? "50");
  const offsetValue = Number(url.searchParams.get("offset") ?? "0");
  const orderBy = url.searchParams.get("orderBy") ?? undefined;
  const orderDirection =
    url.searchParams.get("orderDirection") === "desc" ? "desc" : "asc";
  return {
    limit: Number.isFinite(limitValue)
      ? Math.min(Math.max(Math.trunc(limitValue), 1), 500)
      : 50,
    offset: Number.isFinite(offsetValue)
      ? Math.max(Math.trunc(offsetValue), 0)
      : 0,
    orderBy: orderBy || undefined,
    orderDirection,
  };
}

export function createApp(services = domain) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );
      if (url.pathname === "/api/health") {
        send(response, 200, { status: "ok", time: new Date().toISOString() });
        return;
      }

      const segments = url.pathname.split("/").filter(Boolean);
      if (segments[0] !== "api" || !segments[1] || segments.length > 3) {
        send(response, 404, { error: "not found" });
        return;
      }

      const table = decodeURIComponent(segments[1]);
      const service = services[table];
      if (!service) {
        send(response, 404, { error: `unknown table: ${table}` });
        return;
      }
      const id = segments[2] ? decodeURIComponent(segments[2]) : undefined;
      const method = request.method ?? "GET";

      if (method === "GET" && !id) {
        const search = url.searchParams.get("search")?.trim();
        if (search) {
          const items = await service.search(search);
          send(response, 200, { items, total: items.length });
          return;
        }
        send(response, 200, await service.list(listInput(url)));
        return;
      }

      if (method === "POST" && !id) {
        const body = await readJson(request);
        send(response, 201, await service.create(body));
        return;
      }

      if (method === "GET" && id) {
        const item = await service.get(id);
        if (!item) {
          send(response, 404, { error: `${table} record not found: ${id}` });
          return;
        }
        send(response, 200, item);
        return;
      }

      if (method === "PUT" && id) {
        const existing = await service.get(id);
        if (!existing) {
          send(response, 404, { error: `${table} record not found: ${id}` });
          return;
        }
        const body = await readJson(request);
        send(response, 200, await service.update(id, body));
        return;
      }

      if (method === "DELETE" && id) {
        await service.remove(id);
        send(response, 204);
        return;
      }

      response.writeHead(405, {
        allow: "GET, POST, PUT, DELETE",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ error: "method not allowed" }));
    } catch (error) {
      const status = Number(error?.status) || 400;
      send(response, status, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, host, () => {
    console.log(`[node-api] listening on http://${host}:${port}`);
  });
}
