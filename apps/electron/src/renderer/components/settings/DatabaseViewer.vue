<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'

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

onMounted(() => {
  if (props.active) {
    loadDatabases()
  }
})
</script>

<template>
  <div class="dv-root">
    <!-- DB List view -->
    <div v-if="!selectedDb" class="dv-list">
      <div class="dv-list-header">
        <div>
          <h3 class="dv-title">{{ $t('settings.database.title') }}</h3>
          <p class="dv-desc">{{ $t('settings.database.description') }}</p>
        </div>
        <div class="dv-list-actions">
          <input
            v-model="dbSearchQuery"
            type="text"
            :placeholder="$t('settings.database.searchPlaceholder')"
            class="dv-search"
          />
          <button class="dv-btn" @click="loadDatabases" :disabled="dbLoading">{{ $t('settings.database.refresh') }}</button>
        </div>
      </div>

      <div class="dv-separator" />

      <div v-if="dbLoading" class="dv-empty">{{ $t('settings.database.loading') }}</div>
      <div v-else-if="dbError" class="dv-empty dv-error">{{ dbError }}</div>
      <div v-else-if="filteredDatabases.length === 0" class="dv-empty">
        <p>{{ $t('settings.database.emptyTitle') }}</p>
        <p class="dv-empty-hint">{{ $t('settings.database.emptyHint') }}</p>
      </div>

      <div v-else class="dv-items">
        <div
          v-for="db in filteredDatabases"
          :key="db.projectId"
          class="dv-item"
          @click="selectDatabase(db)"
        >
          <div class="dv-item-top">
            <span class="dv-item-icon">{{ db.database === 'sqlite' ? '🗃️' : '📄' }}</span>
            <div class="dv-item-info">
              <span class="dv-item-name">{{ db.projectName }}</span>
              <span class="dv-item-type">{{ db.database }} · {{ db.dbPath }}</span>
            </div>
            <span class="dv-item-arrow">›</span>
          </div>
          <div class="dv-item-tables" v-if="db.tables.length">
            <span
              v-for="table in db.tables.slice(0, 5)"
              :key="table.name"
              class="dv-tag"
            >{{ table.name }}<small v-if="table.rowCount >= 0"> ({{ table.rowCount }})</small></span>
            <span v-if="db.tables.length > 5" class="dv-tag dv-tag-more">+{{ db.tables.length - 5 }}</span>
          </div>
          <div v-else class="dv-item-no-tables">{{ $t('settings.database.noTables') }}</div>
        </div>
      </div>
    </div>

    <!-- DB Detail / Table viewer -->
    <div v-else class="dv-detail">
      <div class="dv-detail-header">
        <button class="dv-back" @click="backToDbList">{{ $t('settings.database.back') }}</button>
        <div>
          <h3 class="dv-title">{{ selectedDb.projectName }}</h3>
          <span class="dv-detail-sub">{{ selectedDb.database }} · {{ selectedDb.dbPath }}</span>
        </div>
      </div>

      <div class="dv-detail-layout">
        <!-- Table list sidebar -->
        <div class="dv-sidebar">
          <div class="dv-sidebar-title">{{ $t('settings.database.tableListTitle', { count: selectedDb.tables.length }) }}</div>
          <div
            v-for="table in selectedDb.tables"
            :key="table.name"
            :class="['dv-sidebar-item', { active: selectedTable === table.name }]"
            @click="selectTable(table.name)"
          >
            <span class="dv-sidebar-name">{{ table.name }}</span>
            <span class="dv-sidebar-count" v-if="table.rowCount >= 0">{{ table.rowCount }}</span>
          </div>
          <div v-if="selectedDb.tables.length === 0" class="dv-sidebar-empty">{{ $t('settings.database.emptyTables') }}</div>
        </div>

        <!-- Table data -->
        <div class="dv-content">
          <div v-if="!selectedTable" class="dv-placeholder">
            <span>{{ $t('settings.database.selectTableHint') }}</span>
          </div>
          <template v-else>
            <div class="dv-schema">
              <span class="dv-schema-label">{{ $t('settings.database.fieldsLabel') }}</span>
              <span
                v-for="col in tableColumns"
                :key="col.name"
                :class="['dv-col', { pk: col.primaryKey }]"
                :title="col.type + (col.primaryKey ? ' [PK]' : '')"
              >{{ col.name }}<small>{{ col.type }}</small></span>
            </div>

            <div v-if="tableLoading" class="dv-loading">{{ $t('settings.database.loading') }}</div>
            <div v-else-if="tableRows.length === 0" class="dv-loading">{{ $t('settings.database.noData') }}</div>
            <div v-else class="dv-table-wrap">
              <table class="dv-table">
                <thead>
                  <tr>
                    <th v-for="col in tableColumns" :key="col.name">{{ col.name }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, i) in tableRows" :key="i">
                    <td v-for="col in tableColumns" :key="col.name">{{ row[col.name] ?? '' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="dv-pagination">
              <span class="dv-page-info">{{ $t('settings.database.pageInfo', { total: tableTotal, page: tablePage, pages: totalPages }) }}</span>
              <div class="dv-page-btns">
                <button class="dv-page-btn" :disabled="tablePage <= 1" @click="prevPage">{{ $t('settings.database.previousPage') }}</button>
                <button class="dv-page-btn" :disabled="tablePage >= totalPages" @click="nextPage">{{ $t('settings.database.nextPage') }}</button>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dv-root { flex: 1; display: flex; flex-direction: column; overflow: hidden; color: var(--app-text); }

/* ── List View ── */
.dv-list { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.dv-list-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: 20px 28px 0; flex-shrink: 0; gap: 16px;
}
.dv-title { margin: 0 0 4px; font-size: 1.1em; color: var(--app-text-strong); }
.dv-desc { margin: 0; font-size: 0.85em; color: var(--app-text-muted); }
.dv-list-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }

.dv-search {
  background: var(--app-input-bg); border: 1px solid var(--app-border); border-radius: 8px;
  color: var(--app-text); padding: 7px 14px; font-size: 0.85em; outline: none;
  width: 200px; transition: border-color 0.15s;
}
.dv-search:focus { border-color: var(--app-accent); }
.dv-search::placeholder { color: var(--app-text-faint); }

.dv-btn {
  padding: 7px 14px; background: var(--app-panel-muted); border: 1px solid var(--app-border);
  border-radius: 8px; color: var(--app-text); font-size: 0.82em; cursor: pointer;
}
.dv-btn:hover { background: var(--app-panel); }
.dv-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.dv-separator { height: 1px; background: var(--app-border); margin: 16px 28px; flex-shrink: 0; }

.dv-empty {
  text-align: center; padding: 40px 20px; color: var(--app-text-muted); flex: 1;
  display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 0.9em;
}
.dv-error { color: var(--app-danger, #ef4444); }
.dv-empty-hint { font-size: 0.82em; color: var(--app-text-faint); margin-top: 6px; }

.dv-items { flex: 1; overflow-y: auto; padding: 0 28px 20px; display: flex; flex-direction: column; }

.dv-item {
  padding: 12px 4px; border-bottom: 1px solid var(--app-border);
  cursor: pointer; transition: background 0.12s;
}
.dv-item:last-child { border-bottom: none; }
.dv-item:hover { background: var(--app-panel-muted); }

.dv-item-top { display: flex; align-items: center; gap: 12px; }
.dv-item-icon { font-size: 1.3em; flex-shrink: 0; }
.dv-item-info { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.dv-item-name { font-size: 0.92em; font-weight: 500; color: var(--app-text); }
.dv-item-type { font-size: 0.78em; color: var(--app-text-muted); }
.dv-item-arrow { font-size: 1.1em; color: var(--app-text-faint); flex-shrink: 0; }

.dv-item-tables { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; padding-left: 44px; }
.dv-tag {
  background: var(--app-panel-muted); border-radius: 6px;
  padding: 2px 8px; font-size: 0.75em; color: var(--app-text-soft);
}
.dv-tag small { color: var(--app-text-faint); margin-left: 2px; }
.dv-tag-more { color: var(--app-accent); }
.dv-item-no-tables { font-size: 0.78em; color: var(--app-text-faint); margin-top: 6px; padding-left: 44px; }

/* ── Detail View ── */
.dv-detail { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.dv-detail-header {
  display: flex; align-items: center; gap: 14px;
  padding: 14px 28px; border-bottom: 1px solid var(--app-border); flex-shrink: 0;
}
.dv-detail-sub { font-size: 0.78em; color: var(--app-text-muted); }
.dv-back {
  background: none; border: 1px solid var(--app-border); border-radius: 8px;
  color: var(--app-text); padding: 6px 14px; font-size: 0.82em; cursor: pointer;
}
.dv-back:hover { background: var(--app-panel-muted); color: var(--app-text-strong); }

.dv-detail-layout { flex: 1; display: flex; overflow: hidden; }

.dv-sidebar {
  width: 200px; border-right: 1px solid var(--app-border);
  overflow-y: auto; flex-shrink: 0;
}
.dv-sidebar-title {
  padding: 12px 16px; font-size: 0.82em; color: var(--app-text-muted); font-weight: 500;
  border-bottom: 1px solid var(--app-border);
}
.dv-sidebar-item {
  padding: 10px 16px; cursor: pointer; transition: background 0.12s;
  display: flex; justify-content: space-between; align-items: center;
  border-bottom: 1px solid var(--app-border);
}
.dv-sidebar-item:hover { background: var(--app-panel-muted); }
.dv-sidebar-item.active { background: var(--app-panel-muted); color: var(--app-accent); }
.dv-sidebar-name { font-size: 0.85em; color: var(--app-text); }
.dv-sidebar-item.active .dv-sidebar-name { color: var(--app-accent); }
.dv-sidebar-count { font-size: 0.72em; color: var(--app-text-muted); }
.dv-sidebar-empty { padding: 20px 16px; text-align: center; color: var(--app-text-faint); font-size: 0.82em; }

.dv-content { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.dv-placeholder {
  flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--app-text-faint); font-size: 0.9em;
}

.dv-schema {
  display: flex; align-items: center; gap: 6px; padding: 10px 16px;
  border-bottom: 1px solid var(--app-border); flex-shrink: 0;
  flex-wrap: wrap; overflow-x: auto;
}
.dv-schema-label { font-size: 0.78em; color: var(--app-text-muted); margin-right: 4px; }
.dv-col {
  background: var(--app-panel-muted); border-radius: 6px;
  padding: 2px 8px; font-size: 0.75em; color: var(--app-text-soft); white-space: nowrap;
}
.dv-col.pk { color: var(--app-accent); }
.dv-col small { color: var(--app-text-faint); margin-left: 4px; font-size: 0.9em; }

.dv-loading {
  flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--app-text-muted); font-size: 0.88em;
}

.dv-table-wrap { flex: 1; overflow: auto; }
.dv-table { width: 100%; border-collapse: collapse; font-size: 0.82em; }
.dv-table th {
  text-align: left; padding: 8px 12px; color: var(--app-text-muted);
  border-bottom: 1px solid var(--app-border); font-weight: 500;
  position: sticky; top: 0; background: var(--app-panel); z-index: 1;
}
.dv-table td {
  padding: 7px 12px; border-bottom: 1px solid var(--app-border); color: var(--app-text-soft);
  max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dv-table tr:hover td { background: var(--app-panel-muted); }

.dv-pagination {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px; border-top: 1px solid var(--app-border); flex-shrink: 0;
}
.dv-page-info { font-size: 0.78em; color: var(--app-text-muted); }
.dv-page-btns { display: flex; gap: 6px; }
.dv-page-btn {
  padding: 4px 12px; background: var(--app-panel-muted); border: 1px solid var(--app-border);
  border-radius: 8px; color: var(--app-text); font-size: 0.78em; cursor: pointer;
}
.dv-page-btn:hover:not(:disabled) { background: var(--app-panel); color: var(--app-text-strong); }
.dv-page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
