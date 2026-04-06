type JsonRecord = Record<string, unknown>

function isRecord (value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractFirstJsonObject (value: string): string | null {
  const source = value.trim()
  const start = source.indexOf('{')
  if (start === -1) {
    return null
  }

  let depth = 0
  let inString = false
  let isEscaped = false

  for (let index = start; index < source.length; index++) {
    const char = source[index]

    if (inString) {
      if (isEscaped) {
        isEscaped = false
        continue
      }
      if (char === '\\') {
        isEscaped = true
        continue
      }
      if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return source.slice(start, index + 1)
      }
    }
  }

  return null
}

function tryParseObjectJson (value: string): JsonRecord | null {
  const candidate = extractFirstJsonObject(value) || value.trim()
  try {
    const parsed = JSON.parse(candidate) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function stripNumericKeys (value: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^\d+$/.test(key)))
}

function recoverSpreadStringObject (value: JsonRecord): JsonRecord | null {
  const numericEntries = Object.entries(value)
    .filter(([key, entryValue]) => /^\d+$/.test(key) && typeof entryValue === 'string')
    .sort((left, right) => Number(left[0]) - Number(right[0]))

  if (numericEntries.length < 2) {
    return null
  }

  const joined = numericEntries.map(([, entryValue]) => entryValue).join('').trim()
  if (!joined.startsWith('{')) {
    return null
  }

  return tryParseObjectJson(joined)
}

function normalizeDefaultField (column: JsonRecord): JsonRecord {
  if ('defaultSql' in column || 'defaultValue' in column || !('default' in column)) {
    return column
  }

  const nextColumn = { ...column }
  const defaultValue = nextColumn.default
  delete nextColumn.default

  if (typeof defaultValue === 'string') {
    const normalized = defaultValue.trim().toUpperCase()
    if (['CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'NULL'].includes(normalized)) {
      nextColumn.defaultSql = normalized
      return nextColumn
    }
  }

  nextColumn.defaultValue = defaultValue
  return nextColumn
}

function normalizeColumns (columns: unknown): JsonRecord[] | undefined {
  if (Array.isArray(columns)) {
    return columns
      .map(column => {
        if (!isRecord(column)) return null
        if (typeof column.name !== 'string' || typeof column.type !== 'string') return null
        return normalizeDefaultField(column)
      })
      .filter((column): column is JsonRecord => column !== null)
  }

  if (!isRecord(columns)) {
    return undefined
  }

  return Object.entries(columns).map(([name, column]) => {
    const base = isRecord(column) ? column : {}
    return normalizeDefaultField({ name, ...base })
  })
}

function normalizeTables (tables: unknown): JsonRecord[] | undefined {
  if (Array.isArray(tables)) {
    return tables
      .map(table => {
        if (!isRecord(table) || typeof table.name !== 'string') return null
        const normalizedColumns = normalizeColumns(table.columns)
        return {
          ...table,
          ...(normalizedColumns ? { columns: normalizedColumns } : {})
        }
      })
      .filter((table): table is JsonRecord => table !== null)
  }

  if (!isRecord(tables)) {
    return undefined
  }

  return Object.entries(tables).map(([name, table]) => {
    const base = isRecord(table) ? table : {}
    const normalizedColumns = normalizeColumns(base.columns)
    return {
      ...base,
      name,
      ...(normalizedColumns ? { columns: normalizedColumns } : {})
    }
  })
}

export function normalizeDataSchema (schema: unknown): JsonRecord | null {
  if (!isRecord(schema)) {
    return null
  }

  const normalizedTables = normalizeTables(schema.tables)

  return {
    ...schema,
    ...(normalizedTables ? { tables: normalizedTables } : {})
  }
}

export function normalizeProjectMeta (meta: unknown): JsonRecord {
  if (typeof meta === 'string') {
    const parsed = tryParseObjectJson(meta)
    return parsed ? normalizeProjectMeta(parsed) : {}
  }

  if (!isRecord(meta)) {
    return {}
  }

  const recovered = recoverSpreadStringObject(meta)
  const base = {
    ...(recovered || {}),
    ...stripNumericKeys(meta)
  }

  const normalizedDataSchema = normalizeDataSchema(base.dataSchema)
  return {
    ...base,
    ...(normalizedDataSchema ? { dataSchema: normalizedDataSchema } : {})
  }
}