import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  deleteRecords,
  newId,
  queryRecords,
  saveRecords,
} from "../src/server/data/core.mjs";

let directory;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "worldbase-data-"));
  process.env.WORLDBASE_DATA_DIR = directory;
  delete process.env.WORLDBASE_DATA_API_URL;
});

after(async () => {
  delete process.env.WORLDBASE_DATA_DIR;
  await rm(directory, { recursive: true, force: true });
});

test("insert, query, upsert and delete records", async () => {
  const first = {
    id: newId(),
    title: "Coffee",
    amount: 4.5,
    created_at: new Date().toISOString(),
  };
  await saveRecords("expenses", [first], "insert");

  assert.deepEqual(
    await queryRecords("expenses", { filters: { title: "Coffee" } }),
    [first],
  );

  await saveRecords("expenses", [{ id: first.id, amount: 5 }], "upsert");
  const [updated] = await queryRecords("expenses", { limit: 1 });
  assert.equal(updated.amount, 5);
  assert.equal(updated.title, "Coffee");

  await deleteRecords("expenses", [first.id]);
  assert.deepEqual(await queryRecords("expenses"), []);
});

test("orders and projects columns", async () => {
  const records = [
    { id: newId(), title: "A", amount: 2 },
    { id: newId(), title: "B", amount: 1 },
    { id: newId(), title: "C", amount: 3 },
  ];
  await saveRecords("ordered", records, "insert");

  const descending = await queryRecords("ordered", {
    orderBy: "amount",
    orderDirection: "desc",
    columns: ["title"],
  });
  assert.deepEqual(descending, [
    { title: "C" },
    { title: "A" },
    { title: "B" },
  ]);

  const page = await queryRecords("ordered", { limit: 1, offset: 1 });
  assert.equal(page.length, 1);
  assert.equal(page[0].amount, 1);
});
