import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const TABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const tableQueues = new Map();

export function newId() {
  return randomUUID();
}

function dataDir() {
  const configured = process.env.WORLDBASE_DATA_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  const root = process.env.WORLDBASE_PROJECT_DIR?.trim() || process.cwd();
  return path.join(root, "data");
}

function hostBaseUrl() {
  return process.env.WORLDBASE_DATA_API_URL?.trim().replace(/\/+$/, "") ?? "";
}

function hostToken() {
  return (
    process.env.WORLDBASE_DATA_API_TOKEN?.trim() ||
    process.env.WORLDBASE_APP_TOKEN?.trim() ||
    ""
  );
}

function ensureTable(table) {
  if (typeof table !== "string" || !TABLE_PATTERN.test(table)) {
    throw new Error(`invalid table name: ${String(table)}`);
  }
  return table;
}

function withTableLock(table, task) {
  const previous = tableQueues.get(table) ?? Promise.resolve();
  const run = previous.then(task, task);
  tableQueues.set(
    table,
    run.catch(() => {}),
  );
  return run;
}

async function readTable(table) {
  const file = path.join(dataDir(), `${table}.json`);
  try {
    const text = await readFile(file, "utf8");
    const value = text.trim() ? JSON.parse(text) : [];
    if (!Array.isArray(value)) {
      throw new Error(`data file for ${table} must contain an array`);
    }
    return value;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeTable(table, records) {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${table}.json`);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

function matchesFilters(record, filters) {
  if (!filters) {
    return true;
  }
  return Object.entries(filters).every(([key, expected]) => {
    const actual = record[key];
    if (Array.isArray(expected)) {
      return expected.some((value) => value === actual);
    }
    if (expected === null) {
      return actual === null || actual === undefined;
    }
    return actual === expected;
  });
}

function sortRecords(records, orderBy, orderDirection) {
  if (!orderBy) {
    return records;
  }
  const direction = orderDirection === "desc" ? -1 : 1;
  return [...records].sort((left, right) => {
    const a = left[orderBy];
    const b = right[orderBy];
    if (a === b) {
      return 0;
    }
    if (a === null || a === undefined) {
      return 1;
    }
    if (b === null || b === undefined) {
      return -1;
    }
    return (a < b ? -1 : 1) * direction;
  });
}

async function queryLocal(table, input = {}) {
  let records = (await readTable(table)).filter((record) =>
    matchesFilters(record, input.filters),
  );
  records = sortRecords(records, input.orderBy, input.orderDirection);
  const offset = Number.isFinite(input.offset)
    ? Math.max(0, Math.trunc(input.offset))
    : 0;
  records = records.slice(offset);
  if (Number.isFinite(input.limit)) {
    records = records.slice(0, Math.max(0, Math.trunc(input.limit)));
  }
  const columns = Array.isArray(input.columns)
    ? input.columns.filter((column) => typeof column === "string")
    : [];
  if (columns.length > 0) {
    records = records.map((record) => {
      const projected = {};
      for (const column of columns) {
        if (column in record) {
          projected[column] = record[column];
        }
      }
      return projected;
    });
  }
  return records;
}

function primaryKey(record, idField) {
  const value = record?.[idField];
  return value === undefined || value === null ? null : String(value);
}

async function saveLocal(table, records, mode, idField) {
  const existing = await readTable(table);
  if (mode === "insert") {
    await writeTable(table, [...existing, ...records]);
    return;
  }
  const positions = new Map();
  existing.forEach((record, position) => {
    const key = primaryKey(record, idField);
    if (key !== null) {
      positions.set(key, position);
    }
  });
  const next = [...existing];
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("record must be an object");
    }
    const key = primaryKey(record, idField);
    if (key !== null && positions.has(key)) {
      const position = positions.get(key);
      next[position] = { ...next[position], ...record };
    } else {
      if (key !== null) {
        positions.set(key, next.length);
      }
      next.push(record);
    }
  }
  await writeTable(table, next);
}

async function deleteLocal(table, ids, idField) {
  const drop = new Set(ids.map((id) => String(id)));
  const existing = await readTable(table);
  await writeTable(
    table,
    existing.filter((record) => !drop.has(String(record?.[idField] ?? ""))),
  );
}

async function callHost(endpoint, body) {
  const base = hostBaseUrl();
  const headers = { "content-type": "application/json" };
  const token = hostToken();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${base}/data/${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    throw new Error(
      `host data API ${endpoint} failed (${response.status}): ${text || response.statusText}`,
    );
  }
  if (payload && payload.ok === false) {
    throw new Error(
      payload.message || payload.error || `host data API ${endpoint} failed`,
    );
  }
  return payload;
}

export async function queryRecords(table, input = {}) {
  ensureTable(table);
  if (hostBaseUrl()) {
    const payload = await callHost("query", { table, ...input });
    const records = Array.isArray(payload)
      ? payload
      : (payload?.records ?? payload?.data ?? []);
    return Array.isArray(records) ? records : [];
  }
  return withTableLock(table, () => queryLocal(table, input));
}

export async function saveRecords(table, records, mode = "upsert", idField = "id") {
  ensureTable(table);
  if (mode !== "insert" && mode !== "upsert") {
    throw new Error(`invalid save mode: ${mode}`);
  }
  if (!Array.isArray(records)) {
    throw new Error("records must be an array");
  }
  if (hostBaseUrl()) {
    await callHost("save", { table, records, mode });
    return;
  }
  return withTableLock(table, () => saveLocal(table, records, mode, idField));
}

export async function deleteRecords(table, ids, idField = "id") {
  ensureTable(table);
  const list = (Array.isArray(ids) ? ids : [ids]).map((id) => String(id));
  if (hostBaseUrl()) {
    await callHost("delete", { table, ids: list });
    return;
  }
  return withTableLock(table, () => deleteLocal(table, list, idField));
}
