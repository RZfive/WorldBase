<script setup lang="ts">
import { ref, computed, watch } from 'vue'

interface DatabaseTableColumn {
  name: string
  type: string
  primaryKey: boolean
}

interface DatabaseTable {
  name: string
  rowCount: number
  columns: DatabaseTableColumn[]
}

interface DatabaseInfo {
  projectId: string
  projectName: string
  database: string
  dbPath: string
  fullPath: string
  tables: DatabaseTable[]
}

const props = defineProps<{
  active: boolean
}>()

const databases = ref<DatabaseInfo[]>([])
const dbLoading = ref(false)
const dbError = ref<string | null>(null)
const selectedDb = ref<DatabaseInfo | null>(null)
const selectedTable = ref<string | null>(null)
const tableRows = ref<Record<string, unknown>[]>([])
const tableTotal = ref(0)
const tablePage = ref(1)
const tablePageSize = ref(50)
const tableLoading = ref(false)
const dbSearchQuery = ref('')

const filteredDatabases = computed(() => {
  const q = dbSearchQuery.value.trim().toLowerCase()
  if (!q) return databases.value
  return databases.value.filter(db =>
    db.projectName.toLowerCase().includes(q) ||
    db.projectId.toLowerCase().includes(q) ||
    db.tables.some(t => t.name.toLowerCase().includes(q))
  )
})

const tableColumns = computed(() => {
  if (!selectedDb.value || !selectedTable.value) return []
  const table = selectedDb.value.tables.find(t => t.name === selectedTable.value)
  return table?.columns || []
})

const totalPages = computed(() => Math.max(1, Math.ceil(tableTotal.value / tablePageSize.value)))

// Watch active prop to trigger lazy loading on first tab visit
watch(() => props.active, (val) => {
  if (val && databases.value.length === 0) {
    loadDatabases()
  }
})

async function loadDatabases () {
  if (!window.electronAPI?.listAllDatabases) return
  dbLoading.value = true
  dbError.value = null
  try {
    databases.value = await window.electronAPI.listAllDatabases() as unknown as DatabaseInfo[]
  } catch (err) {
    dbError.value = (err as Error).message
  } finally {
    dbLoading.value = false
  }
}

async function selectDatabase (db: DatabaseInfo) {
  selectedDb.value = db
  selectedTable.value = null
  tableRows.value = []
  tableTotal.value = 0
}

async function selectTable (tableName: string) {
  selectedTable.value = tableName
  tablePage.value = 1
  await loadTableData()
}

async function loadTableData () {
  if (!window.electronAPI?.queryTable || !selectedDb.value || !selectedTable.value) return
  tableLoading.value = true
  try {
    const result = await window.electronAPI.queryTable(
      selectedDb.value.projectId,
      selectedTable.value,
      tablePage.value,
      tablePageSize.value
    )
    tableRows.value = result.rows
    tableTotal.value = result.total
  } catch (err) {
    console.error('Failed to load table data:', err)
    tableRows.value = []
    tableTotal.value = 0
  } finally {
    tableLoading.value = false
  }
}

async function prevPage () {
  if (tablePage.value > 1) {
    tablePage.value--
    await loadTableData()
  }
}

async function nextPage () {
  if (tablePage.value < totalPages.value) {
    tablePage.value++
    await loadTableData()
  }
}

function backToDbList () {
  selectedDb.value = null
  selectedTable.value = null
  tableRows.value = []
}
</script>

<template>
  <div class="db-viewer">
    <!-- DB List view -->
    <div v-if="!selectedDb" class="db-list-view">
      <div class="db-list-header">
        <h3>📊 数据库总览</h3>
        <div class="db-list-actions">
          <input
            v-model="dbSearchQuery"
            type="text"
            placeholder="搜索项目或表名…"
            class="db-search-input"
          />
          <button class="lp-btn" @click="loadDatabases" :disabled="dbLoading">🔄 刷新</button>
        </div>
      </div>

      <div v-if="dbLoading" class="db-empty">加载中…</div>
      <div v-else-if="dbError" class="db-empty db-error">❌ {{ dbError }}</div>
      <div v-else-if="filteredDatabases.length === 0" class="db-empty">
        <div class="db-empty-icon">🗄️</div>
        <p>暂无数据库</p>
        <p class="db-empty-hint">当项目配置了数据存储后，这里将展示所有数据库信息</p>
      </div>

      <div v-else class="db-cards">
        <div
          v-for="db in filteredDatabases"
          :key="db.projectId"
          class="db-card"
          @click="selectDatabase(db)"
        >
          <div class="db-card-header">
            <span class="db-card-icon">{{ db.database === 'sqlite' ? '🗃️' : '📄' }}</span>
            <div class="db-card-info">
              <div class="db-card-name">{{ db.projectName }}</div>
              <div class="db-card-type">{{ db.database }} · {{ db.dbPath }}</div>
            </div>
          </div>
          <div class="db-card-tables">
            <span
              v-for="table in db.tables.slice(0, 5)"
              :key="table.name"
              class="db-table-badge"
            >
              {{ table.name }}
              <small v-if="table.rowCount >= 0">({{ table.rowCount }})</small>
            </span>
            <span v-if="db.tables.length > 5" class="db-table-badge more">+{{ db.tables.length - 5 }}</span>
            <span v-if="db.tables.length === 0" class="db-no-tables">无表</span>
          </div>
        </div>
      </div>
    </div>

    <!-- DB Detail / Table viewer -->
    <div v-else class="db-detail-view">
      <div class="db-detail-header">
        <button class="db-back-btn" @click="backToDbList">← 返回</button>
        <div>
          <h3>{{ selectedDb.projectName }}</h3>
          <span class="db-detail-sub">{{ selectedDb.database }} · {{ selectedDb.dbPath }}</span>
        </div>
      </div>

      <div class="db-detail-layout">
        <!-- Table list sidebar -->
        <div class="db-tables-sidebar">
          <div class="db-tables-title">表 ({{ selectedDb.tables.length }})</div>
          <div
            v-for="table in selectedDb.tables"
            :key="table.name"
            :class="['db-table-item', { active: selectedTable === table.name }]"
            @click="selectTable(table.name)"
          >
            <span class="db-table-name">{{ table.name }}</span>
            <span class="db-table-count" v-if="table.rowCount >= 0">{{ table.rowCount }} 行</span>
          </div>
          <div v-if="selectedDb.tables.length === 0" class="db-tables-empty">此数据库暂无表</div>
        </div>

        <!-- Table data -->
        <div class="db-table-content">
          <div v-if="!selectedTable" class="db-table-placeholder">
            <span>👈 选择一个表查看数据</span>
          </div>
          <template v-else>
            <!-- Column schema -->
            <div class="db-schema-bar">
              <span class="db-schema-label">字段:</span>
              <span
                v-for="col in tableColumns"
                :key="col.name"
                :class="['db-col-badge', { pk: col.primaryKey }]"
                :title="col.type + (col.primaryKey ? ' [PK]' : '')"
              >
                {{ col.name }}<small>{{ col.type }}</small>
              </span>
            </div>

            <!-- Data table -->
            <div v-if="tableLoading" class="db-table-loading">加载中…</div>
            <div v-else-if="tableRows.length === 0" class="db-table-empty-data">无数据</div>
            <div v-else class="db-data-table-wrapper">
              <table class="db-data-table">
                <thead>
                  <tr>
                    <th v-for="col in tableColumns" :key="col.name">{{ col.name }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, i) in tableRows" :key="i">
                    <td v-for="col in tableColumns" :key="col.name">
                      {{ row[col.name] ?? '' }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- Pagination -->
            <div class="db-pagination">
              <span class="db-page-info">共 {{ tableTotal }} 条 · 第 {{ tablePage }}/{{ totalPages }} 页</span>
              <div class="db-page-btns">
                <button class="db-page-btn" :disabled="tablePage <= 1" @click="prevPage">‹ 上一页</button>
                <button class="db-page-btn" :disabled="tablePage >= totalPages" @click="nextPage">下一页 ›</button>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.db-viewer { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

.db-list-view { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.db-list-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 24px 12px; flex-shrink: 0;
}
.db-list-header h3 { margin: 0; font-size: 1.05em; color: #f4f4f5; }
.db-list-actions { display: flex; gap: 8px; align-items: center; }
.db-search-input {
  background: #1e1e22; border: 1px solid #27272a; border-radius: 8px;
  color: #e4e4e7; padding: 7px 14px; font-size: 0.85em; outline: none;
  width: 200px; transition: border-color 0.15s;
}
.db-search-input:focus { border-color: #6366f1; }
.db-search-input::placeholder { color: #52525b; }

.lp-btn {
  padding: 6px 14px; background: #27272a; border: 1px solid #3f3f46;
  border-radius: 8px; color: #e4e4e7; font-size: 0.82em; cursor: pointer;
  white-space: nowrap; transition: all 0.12s;
}
.lp-btn:hover { background: #3f3f46; }
.lp-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.db-empty {
  text-align: center; padding: 60px 20px; color: #71717a; flex: 1;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.db-error { color: #f87171; }
.db-empty-icon { font-size: 2.5em; margin-bottom: 12px; }
.db-empty-hint { font-size: 0.82em; color: #52525b; margin-top: 6px; }

.db-cards {
  flex: 1; overflow-y: auto; padding: 0 24px 24px;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px; align-content: start;
}
.db-card {
  background: #18181b; border: 1px solid #27272a; border-radius: 12px;
  padding: 16px 18px; cursor: pointer; transition: all 0.15s;
}
.db-card:hover { border-color: #6366f1; background: #1c1c20; }
.db-card-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.db-card-icon { font-size: 1.8em; }
.db-card-name { font-weight: 600; font-size: 0.95em; color: #e4e4e7; }
.db-card-type { font-size: 0.78em; color: #71717a; margin-top: 2px; }
.db-card-tables { display: flex; flex-wrap: wrap; gap: 6px; }
.db-table-badge {
  background: #27272a; border: 1px solid #3f3f46; border-radius: 6px;
  padding: 3px 8px; font-size: 0.75em; color: #a1a1aa;
}
.db-table-badge small { color: #71717a; margin-left: 3px; }
.db-table-badge.more { background: #1e1e22; color: #6366f1; border-color: #6366f180; }
.db-no-tables { font-size: 0.78em; color: #52525b; }

/* DB Detail */
.db-detail-view { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.db-detail-header {
  display: flex; align-items: center; gap: 14px;
  padding: 14px 24px; border-bottom: 1px solid #27272a; flex-shrink: 0;
}
.db-detail-header h3 { margin: 0; font-size: 1em; color: #f4f4f5; }
.db-detail-sub { font-size: 0.78em; color: #71717a; }
.db-back-btn {
  background: #27272a; border: 1px solid #3f3f46; border-radius: 8px;
  color: #a1a1aa; padding: 6px 14px; font-size: 0.82em; cursor: pointer;
}
.db-back-btn:hover { background: #3f3f46; color: #e4e4e7; }

.db-detail-layout { flex: 1; display: flex; overflow: hidden; }

.db-tables-sidebar {
  width: 200px; background: #141416; border-right: 1px solid #27272a;
  overflow-y: auto; flex-shrink: 0;
}
.db-tables-title {
  padding: 12px 16px; font-size: 0.82em; color: #71717a; font-weight: 500;
  border-bottom: 1px solid #27272a;
}
.db-table-item {
  padding: 10px 16px; cursor: pointer; transition: all 0.12s;
  display: flex; justify-content: space-between; align-items: center;
  border-bottom: 1px solid #1f1f23;
}
.db-table-item:hover { background: #1e1e22; }
.db-table-item.active { background: #27272a; }
.db-table-name { font-size: 0.85em; color: #e4e4e7; }
.db-table-count { font-size: 0.72em; color: #71717a; }
.db-tables-empty { padding: 20px 16px; text-align: center; color: #52525b; font-size: 0.82em; }

.db-table-content { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.db-table-placeholder {
  flex: 1; display: flex; align-items: center; justify-content: center;
  color: #52525b; font-size: 0.9em;
}

.db-schema-bar {
  display: flex; align-items: center; gap: 6px; padding: 10px 16px;
  border-bottom: 1px solid #27272a; flex-shrink: 0;
  flex-wrap: wrap; overflow-x: auto;
}
.db-schema-label { font-size: 0.78em; color: #71717a; margin-right: 4px; }
.db-col-badge {
  background: #27272a; border: 1px solid #3f3f46; border-radius: 4px;
  padding: 2px 8px; font-size: 0.75em; color: #a1a1aa; white-space: nowrap;
}
.db-col-badge.pk { border-color: #6366f180; color: #818cf8; }
.db-col-badge small { color: #52525b; margin-left: 4px; font-size: 0.9em; }

.db-table-loading, .db-table-empty-data {
  flex: 1; display: flex; align-items: center; justify-content: center;
  color: #71717a; font-size: 0.88em;
}

.db-data-table-wrapper { flex: 1; overflow: auto; }
.db-data-table { width: 100%; border-collapse: collapse; font-size: 0.82em; }
.db-data-table th {
  text-align: left; padding: 8px 12px; color: #71717a;
  border-bottom: 1px solid #27272a; font-weight: 500;
  position: sticky; top: 0; background: #141416; z-index: 1;
}
.db-data-table td {
  padding: 7px 12px; border-bottom: 1px solid #1f1f23; color: #a1a1aa;
  max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.db-data-table tr:hover td { background: #1a1a1e; }

.db-pagination {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px; border-top: 1px solid #27272a; flex-shrink: 0;
}
.db-page-info { font-size: 0.78em; color: #71717a; }
.db-page-btns { display: flex; gap: 6px; }
.db-page-btn {
  padding: 4px 12px; background: #27272a; border: 1px solid #3f3f46;
  border-radius: 6px; color: #a1a1aa; font-size: 0.78em; cursor: pointer;
}
.db-page-btn:hover:not(:disabled) { background: #3f3f46; color: #e4e4e7; }
.db-page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
