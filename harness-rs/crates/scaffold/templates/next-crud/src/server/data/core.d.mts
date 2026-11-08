export interface QueryRecordsInput {
  filters?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDirection?: "asc" | "desc";
  columns?: string[];
}

export declare function queryRecords<T>(
  table: string,
  input?: QueryRecordsInput,
): Promise<T[]>;

export declare function saveRecords<T>(
  table: string,
  records: T[],
  mode?: "insert" | "upsert",
  idField?: string,
): Promise<void>;

export declare function deleteRecords(
  table: string,
  ids: string[],
  idField?: string,
): Promise<void>;

export declare function newId(): string;
