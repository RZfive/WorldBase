import {
  deleteRecords as deleteRecordsImpl,
  newId as newIdImpl,
  queryRecords as queryRecordsImpl,
  saveRecords as saveRecordsImpl,
} from "./core.mjs";
import type { QueryRecordsInput } from "./core.mjs";

export type { QueryRecordsInput } from "./core.mjs";

/**
 * The host data API is selected with WORLDBASE_DATA_API_URL. When it is not
 * configured the client falls back to a local JSON store under `data/`, which
 * keeps the generated application runnable outside WorldBase.
 */
export async function queryRecords<T>(
  table: string,
  input: QueryRecordsInput = {},
): Promise<T[]> {
  return queryRecordsImpl<T>(table, input);
}

export async function saveRecords<T>(
  table: string,
  records: T[],
  mode: "insert" | "upsert",
): Promise<void> {
  return saveRecordsImpl<T>(table, records, mode);
}

export async function deleteRecords(table: string, ids: string[]): Promise<void> {
  return deleteRecordsImpl(table, ids);
}

export function newId(): string {
  return newIdImpl();
}
