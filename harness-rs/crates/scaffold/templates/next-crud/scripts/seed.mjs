import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.env.WORLDBASE_PROJECT_DIR?.trim() || process.cwd();
const dataDir = process.env.WORLDBASE_DATA_DIR?.trim() || path.join(root, "data");
const host = process.env.WORLDBASE_DATA_API_URL?.trim().replace(/\/+$/, "");

async function loadTables() {
  try {
    const text = await readFile(path.join(root, ".world-meta.json"), "utf8");
    const meta = JSON.parse(text);
    return Array.isArray(meta?.dataSchema?.tables) ? meta.dataSchema.tables : [];
  } catch {
    console.warn("[seed] .world-meta.json not found; nothing to seed");
    return [];
  }
}

function sampleValue(column, tableName, index) {
  const name = String(column.name || "value");
  const type = String(column.type || "TEXT").toUpperCase();
  if (column.primaryKey) {
    return `${tableName}-${index}-${Date.now()}`;
  }
  if (name === "created_at" || name === "updated_at") {
    return new Date().toISOString();
  }
  if (type === "INTEGER" || type === "REAL") {
    return index;
  }
  if (name.includes("email")) {
    return `sample${index}@example.com`;
  }
  if (
    name.includes("title") ||
    name.includes("name") ||
    name.includes("label")
  ) {
    return `Sample ${tableName} ${index}`;
  }
  if (name.includes("description") || name.includes("note")) {
    return `Seeded ${tableName} record`;
  }
  return `sample-${name}-${index}`;
}

async function save(record, table) {
  if (host) {
    const token =
      process.env.WORLDBASE_DATA_API_TOKEN ||
      process.env.WORLDBASE_APP_TOKEN ||
      "";
    const response = await fetch(`${host}/data/save`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ table, records: [record], mode: "insert" }),
    });
    if (!response.ok) {
      throw new Error(
        `seed ${table} failed: ${response.status} ${await response.text()}`,
      );
    }
    return;
  }
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, `${table}.json`);
  let existing = [];
  try {
    existing = JSON.parse(await readFile(file, "utf8"));
  } catch {
    existing = [];
  }
  if (!Array.isArray(existing)) {
    existing = [];
  }
  existing.push(record);
  await writeFile(file, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

const tables = await loadTables();
let created = 0;
for (const [index, table] of tables.entries()) {
  const name = String(table.name || "");
  if (!name) {
    continue;
  }
  const record = {};
  for (const column of table.columns || []) {
    record[column.name] = sampleValue(column, name, index + 1);
  }
  await save(record, name);
  created += 1;
}
console.log(`[seed] seeded ${created} table(s)`);
