import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../server.mjs";

function memoryService() {
  const rows = new Map();
  return {
    async list({ limit = 50, offset = 0 } = {}) {
      const all = [...rows.values()];
      return { items: all.slice(offset, offset + limit), total: all.length };
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async create(input) {
      const record = { id: `record-${rows.size + 1}`, ...input };
      rows.set(record.id, record);
      return record;
    },
    async update(id, input) {
      const existing = rows.get(id);
      if (!existing) {
        throw new Error(`record not found: ${id}`);
      }
      const record = { ...existing, ...input, id };
      rows.set(id, record);
      return record;
    },
    async remove(id) {
      rows.delete(id);
    },
    async search(query) {
      const needle = query.trim().toLowerCase();
      return [...rows.values()].filter((row) =>
        JSON.stringify(row).toLowerCase().includes(needle),
      );
    },
  };
}

let directory;
let server;
let base;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "worldbase-node-api-"));
  process.env.WORLDBASE_DATA_DIR = directory;
  delete process.env.WORLDBASE_DATA_API_URL;
  server = createApp({ expenses: memoryService() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.WORLDBASE_DATA_DIR;
  await rm(directory, { recursive: true, force: true });
});

test("health endpoint reports ok", async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
});

test("crud endpoints round-trip a record", async () => {
  const created = await fetch(`${base}/api/expenses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Coffee", amount: 4 }),
  });
  assert.equal(created.status, 201);
  const record = await created.json();
  assert.equal(record.title, "Coffee");

  const listed = await fetch(`${base}/api/expenses?limit=10`);
  assert.equal(listed.status, 200);
  const page = await listed.json();
  assert.equal(page.total, 1);

  const fetched = await fetch(`${base}/api/expenses/${record.id}`);
  assert.equal(fetched.status, 200);

  const updated = await fetch(`${base}/api/expenses/${record.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount: 5 }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).amount, 5);

  const removed = await fetch(`${base}/api/expenses/${record.id}`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 204);

  const missing = await fetch(`${base}/api/expenses/${record.id}`);
  assert.equal(missing.status, 404);
});

test("unknown tables return 404", async () => {
  const response = await fetch(`${base}/api/unknown`);
  assert.equal(response.status, 404);
});
