<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const apps = ref<ApplicationRecord[]>([])
const grants = ref<ApplicationGrant[]>([])
const audits = ref<ApplicationCallAudit[]>([])
const loading = ref(false)
const refreshing = ref(false)
const error = ref('')
const statusMessage = ref('')
const busyKey = ref('')

const grantDialog = reactive({
  open: false,
  appId: '',
  appName: '',
  capabilityPattern: '*',
  mode: 'ask' as ApplicationGrantMode,
  dataScope: '',
  expiresAt: '',
  saving: false,
  error: ''
})

const grantsByApp = computed(() => {
  const grouped = new Map<string, ApplicationGrant[]>()
  for (const grant of grants.value) {
    const list = grouped.get(grant.appId) || []
    list.push(grant)
    grouped.set(grant.appId, list)
  }
  return grouped
})

const TRUST_LABELS: Record<string, string> = {
  builtin: 'trustBuiltin',
  verified: 'trustVerified',
  community: 'trustCommunity',
  untrusted: 'trustUntrusted'
}
const RISK_LABELS: Record<string, string> = {
  read: 'riskRead',
  write_reversible: 'riskWriteReversible',
  write_destructive: 'riskWriteDestructive',
  external_effect: 'riskExternalEffect'
}
const AVAILABILITY_LABELS: Record<string, string> = {
  available: 'availabilityAvailable',
  disabled: 'availabilityDisabled',
  unavailable: 'availabilityUnavailable',
  starting: 'availabilityStarting'
}
const HEALTH_LABELS: Record<string, string> = {
  ready: 'healthReady',
  starting: 'healthStarting',
  failed: 'healthFailed',
  unavailable: 'healthUnavailable',
  unknown: 'healthUnknown'
}

function trustLabel (level?: string): string {
  const key = level ? TRUST_LABELS[level] : ''
  return key ? t(`settings.applications.${key}`) : (level || t('settings.applications.trustUnknown'))
}

function riskLabel (risk?: string): string {
  const key = risk ? RISK_LABELS[risk] : ''
  return key ? t(`settings.applications.${key}`) : (risk || t('settings.applications.riskUnknown'))
}

function availabilityLabel (availability?: string): string {
  const key = availability ? AVAILABILITY_LABELS[availability] : ''
  return key ? t(`settings.applications.${key}`) : (availability || t('settings.applications.availabilityUnknown'))
}

function healthLabel (status?: string): string {
  const key = status ? HEALTH_LABELS[status] : ''
  return key ? t(`settings.applications.${key}`) : (status || t('settings.applications.healthUnknown'))
}

function grantModeLabel (mode?: string): string {
  if (mode === 'allow') return t('settings.applications.modeAllow')
  if (mode === 'deny') return t('settings.applications.modeDeny')
  return t('settings.applications.modeAsk')
}

function capabilitiesFor (app: ApplicationRecord): ApplicationCapability[] {
  return app.capabilities || []
}

function grantsFor (appId: string): ApplicationGrant[] {
  return grantsByApp.value.get(appId) || []
}

function scopeText (capability: ApplicationCapability): string {
  const scopes = capability.dataScopes || []
  return scopes.length > 0 ? scopes.join(', ') : t('settings.applications.scopeEmpty')
}

function grantScopeText (grant: ApplicationGrant): string {
  const scopes = grant.dataScope || []
  return scopes.length > 0 ? scopes.join(', ') : t('settings.applications.scopeEmpty')
}

function formatTime (value?: string | null): string {
  if (!value) return t('settings.applications.never')
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function formatDuration (durationMs?: number): string {
  const ms = typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : 0
  return t('settings.applications.durationMs', { ms })
}

function appLabel (appId: string): string {
  return apps.value.find(app => app.appId === appId)?.name || appId
}

function isBusy (key: string): boolean {
  return busyKey.value === key
}

async function loadApplications (showLoading = true): Promise<void> {
  const api = window.electronAPI?.applications
  if (!api) {
    error.value = t('settings.applications.unavailable')
    return
  }
  if (showLoading) loading.value = true
  error.value = ''
  try {
    const [appResult, grantResult, auditResult] = await Promise.all([
      api.list(),
      api.grants.list(),
      api.audit.list({ limit: 20 })
    ])
    apps.value = appResult?.apps || []
    grants.value = grantResult?.grants || []
    audits.value = auditResult?.audits || []
  } catch (loadError) {
    error.value = (loadError as Error).message || t('settings.applications.loadFailed')
  } finally {
    if (showLoading) loading.value = false
  }
}

async function refreshApplications (): Promise<void> {
  const api = window.electronAPI?.applications
  if (!api || refreshing.value) return
  refreshing.value = true
  error.value = ''
  try {
    await api.refresh()
    await loadApplications(false)
    statusMessage.value = t('settings.applications.refreshed')
  } catch (refreshError) {
    error.value = (refreshError as Error).message || t('settings.applications.refreshFailed')
  } finally {
    refreshing.value = false
  }
}

async function toggleEnabled (app: ApplicationRecord): Promise<void> {
  const api = window.electronAPI?.applications
  if (!api || busyKey.value) return
  const nextEnabled = !app.enabled
  busyKey.value = `toggle:${app.appId}`
  try {
    await api.setEnabled(app.appId, nextEnabled)
    await loadApplications(false)
    statusMessage.value = nextEnabled
      ? t('settings.applications.toggleOn', { name: app.name || app.appId })
      : t('settings.applications.toggleOff', { name: app.name || app.appId })
  } catch (toggleError) {
    error.value = (toggleError as Error).message || t('settings.applications.toggleFailed')
  } finally {
    busyKey.value = ''
  }
}

function openGrantDialog (app: ApplicationRecord, capabilityPattern = '*'): void {
  grantDialog.open = true
  grantDialog.appId = app.appId
  grantDialog.appName = app.name || app.appId
  grantDialog.capabilityPattern = capabilityPattern || '*'
  grantDialog.mode = 'ask'
  grantDialog.dataScope = ''
  grantDialog.expiresAt = ''
  grantDialog.error = ''
}

function closeGrantDialog (): void {
  if (grantDialog.saving) return
  grantDialog.open = false
}

async function saveGrant (): Promise<void> {
  const api = window.electronAPI?.applications
  if (!api || grantDialog.saving) return
  const capabilityPattern = grantDialog.capabilityPattern.trim()
  if (!capabilityPattern) {
    grantDialog.error = t('settings.applications.capabilityPatternRequired')
    return
  }
  let expiresAt: string | null = null
  if (grantDialog.expiresAt) {
    const expiry = new Date(grantDialog.expiresAt)
    if (Number.isNaN(expiry.getTime())) {
      grantDialog.error = t('settings.applications.expiresAtInvalid')
      return
    }
    expiresAt = expiry.toISOString()
  }
  grantDialog.saving = true
  grantDialog.error = ''
  try {
    await api.grants.save({
      appId: grantDialog.appId,
      capabilityPattern,
      permissions: [],
      dataScope: grantDialog.dataScope.split(',').map(scope => scope.trim()).filter(Boolean),
      mode: grantDialog.mode,
      expiresAt
    })
    grantDialog.open = false
    await loadApplications(false)
    statusMessage.value = t('settings.applications.grantSaved', { app: grantDialog.appName })
  } catch (saveError) {
    grantDialog.error = (saveError as Error).message || t('settings.applications.saveFailed')
  } finally {
    grantDialog.saving = false
  }
}

async function revokeGrant (grant: ApplicationGrant): Promise<void> {
  const api = window.electronAPI?.applications
  if (!api || busyKey.value) return
  busyKey.value = `grant:${grant.id}`
  try {
    await api.grants.revoke(grant.id)
    await loadApplications(false)
    statusMessage.value = t('settings.applications.grantRevoked', { app: appLabel(grant.appId) })
  } catch (revokeError) {
    error.value = (revokeError as Error).message || t('settings.applications.revokeFailed')
  } finally {
    busyKey.value = ''
  }
}

onMounted(() => {
  void loadApplications()
})
</script>

<template>
  <div class="apps-panel">
    <header class="panel-header">
      <div class="panel-heading">
        <h2>{{ $t('settings.applications.title') }}</h2>
        <p>{{ $t('settings.applications.description') }}</p>
      </div>
      <div class="panel-actions">
        <span v-if="statusMessage" class="status-chip">{{ statusMessage }}</span>
        <button class="ghost-btn" :disabled="refreshing || loading" @click="refreshApplications">
          {{ refreshing ? $t('settings.applications.refreshing') : $t('settings.applications.refresh') }}
        </button>
      </div>
    </header>

    <div v-if="loading" class="state-card">
      <span class="spinner" aria-hidden="true" />
      <span>{{ $t('settings.applications.loading') }}</span>
    </div>

    <div v-else-if="error" class="state-card error-state">
      <strong>{{ $t('settings.applications.errorTitle') }}</strong>
      <span>{{ error }}</span>
      <button class="ghost-btn" @click="loadApplications()">{{ $t('settings.applications.retry') }}</button>
    </div>

    <div v-else-if="apps.length === 0" class="state-card empty-state">
      <strong>{{ $t('settings.applications.emptyTitle') }}</strong>
      <span>{{ $t('settings.applications.emptyDescription') }}</span>
    </div>

    <section v-else class="app-list">
      <article v-for="app in apps" :key="app.appId" class="app-card">
        <div class="app-card-head">
          <div class="app-identity">
            <div class="app-name-row">
              <h3>{{ app.name || app.appId }}</h3>
              <span :class="['pill', app.enabled ? 'pill-on' : 'pill-off']">
                {{ app.enabled ? $t('settings.applications.enabled') : $t('settings.applications.disabled') }}
              </span>
            </div>
            <p v-if="app.description" class="app-description">{{ app.description }}</p>
            <div class="app-meta">
              <span><b>{{ $t('settings.applications.source') }}</b>{{ app.sourceId || '—' }}</span>
              <span><b>{{ $t('settings.applications.version') }}</b>{{ app.version || '—' }}</span>
              <span><b>{{ $t('settings.applications.trust') }}</b>{{ trustLabel(app.trustLevel) }}</span>
              <span><b>{{ $t('settings.applications.health') }}</b>{{ healthLabel(app.health?.status) }}</span>
              <span><b>{{ $t('settings.applications.aiReady') }}</b>{{ app.aiReady ? $t('settings.applications.aiReadyYes') : $t('settings.applications.aiReadyNo') }}</span>
            </div>
          </div>
          <label class="toggle" :title="app.enabled ? $t('settings.applications.disable') : $t('settings.applications.enable')">
            <input
              type="checkbox"
              :checked="app.enabled"
              :disabled="isBusy(`toggle:${app.appId}`)"
              :aria-label="`${app.name || app.appId} ${app.enabled ? $t('settings.applications.disable') : $t('settings.applications.enable')}`"
              @change="toggleEnabled(app)"
            >
            <span class="toggle-track"><span class="toggle-thumb" /></span>
          </label>
        </div>

        <div class="section-head">
          <h4>{{ $t('settings.applications.capabilities') }}</h4>
          <button class="mini-btn" @click="openGrantDialog(app)">{{ $t('settings.applications.authorize') }}</button>
        </div>

        <div v-if="capabilitiesFor(app).length > 0" class="table-wrap">
          <table class="capability-table">
            <thead>
              <tr>
                <th>{{ $t('settings.applications.toolName') }}</th>
                <th>{{ $t('settings.applications.risk') }}</th>
                <th>{{ $t('settings.applications.scope') }}</th>
                <th>{{ $t('settings.applications.availability') }}</th>
                <th class="action-col">{{ $t('settings.applications.actions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="capability in capabilitiesFor(app)" :key="capability.capabilityId || capability.toolName">
                <td>
                  <code>{{ capability.toolName }}</code>
                  <span v-if="capability.title" class="cell-sub">{{ capability.title }}</span>
                </td>
                <td>
                  <span :class="['pill', `risk-${capability.risk || 'read'}`]">{{ riskLabel(capability.risk) }}</span>
                </td>
                <td class="scope-cell">{{ scopeText(capability) }}</td>
                <td>
                  <span :class="['pill', `availability-${capability.availability || 'available'}`]">
                    {{ availabilityLabel(capability.availability) }}
                  </span>
                </td>
                <td class="action-col">
                  <button class="mini-btn" @click="openGrantDialog(app, capability.capabilityId || capability.toolName)">
                    {{ $t('settings.applications.authorize') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">{{ $t('settings.applications.noCapabilities') }}</p>

        <div class="section-head">
          <h4>{{ $t('settings.applications.grants') }}</h4>
        </div>
        <div v-if="grantsFor(app.appId).length > 0" class="grant-list">
          <div v-for="grant in grantsFor(app.appId)" :key="grant.id" class="grant-row">
            <div class="grant-main">
              <code>{{ grant.capabilityPattern }}</code>
              <span :class="['pill', `mode-${grant.mode || 'ask'}`]">{{ grantModeLabel(grant.mode) }}</span>
              <span class="grant-scope">{{ grantScopeText(grant) }}</span>
            </div>
            <div class="grant-meta">
              <span>{{ $t('settings.applications.expires') }} {{ formatTime(grant.expiresAt) }}</span>
              <button
                class="mini-btn danger-btn"
                :disabled="isBusy(`grant:${grant.id}`)"
                @click="revokeGrant(grant)"
              >
                {{ isBusy(`grant:${grant.id}`) ? $t('settings.applications.revoking') : $t('settings.applications.revoke') }}
              </button>
            </div>
          </div>
        </div>
        <p v-else class="muted">{{ $t('settings.applications.noGrants') }}</p>
      </article>
    </section>

    <section v-if="!loading && !error" class="audit-section">
      <div class="section-head">
        <div>
          <h4>{{ $t('settings.applications.auditTitle') }}</h4>
          <p class="section-hint">{{ $t('settings.applications.auditDescription') }}</p>
        </div>
      </div>
      <div v-if="audits.length > 0" class="audit-list">
        <div v-for="audit in audits" :key="audit.callId" class="audit-row">
          <span class="audit-time">{{ formatTime(audit.createdAt) }}</span>
          <span class="audit-main">
            <strong>{{ appLabel(audit.appId) }}</strong>
            <code>{{ audit.capabilityId }}</code>
          </span>
          <span :class="['pill', `audit-${audit.status || 'unknown'}`]">{{ audit.status || '—' }}</span>
          <span class="audit-duration">{{ formatDuration(audit.durationMs) }}</span>
        </div>
      </div>
      <p v-else class="muted">{{ $t('settings.applications.auditEmpty') }}</p>
    </section>

    <div v-if="grantDialog.open" class="dialog-backdrop" @click.self="closeGrantDialog">
      <div class="grant-dialog" role="dialog" aria-modal="true" :aria-label="$t('settings.applications.grantDialogTitle')">
        <header class="dialog-head">
          <div>
            <h3>{{ $t('settings.applications.grantDialogTitle') }}</h3>
            <p>{{ grantDialog.appName }}</p>
          </div>
          <button class="icon-btn" :aria-label="$t('settings.applications.close')" @click="closeGrantDialog">×</button>
        </header>
        <div class="dialog-body">
          <label class="field">
            <span>{{ $t('settings.applications.capabilityPattern') }}</span>
            <input v-model="grantDialog.capabilityPattern" class="input" placeholder="*">
            <small>{{ $t('settings.applications.capabilityPatternHint') }}</small>
          </label>
          <label class="field">
            <span>{{ $t('settings.applications.grantMode') }}</span>
            <select v-model="grantDialog.mode" class="input">
              <option value="allow">{{ $t('settings.applications.modeAllow') }}</option>
              <option value="ask">{{ $t('settings.applications.modeAsk') }}</option>
              <option value="deny">{{ $t('settings.applications.modeDeny') }}</option>
            </select>
            <small>{{ $t('settings.applications.grantModeHint') }}</small>
          </label>
          <label class="field">
            <span>{{ $t('settings.applications.dataScope') }}</span>
            <input v-model="grantDialog.dataScope" class="input" :placeholder="$t('settings.applications.dataScopePlaceholder')">
            <small>{{ $t('settings.applications.dataScopeHint') }}</small>
          </label>
          <label class="field">
            <span>{{ $t('settings.applications.expiresAt') }}</span>
            <input v-model="grantDialog.expiresAt" type="datetime-local" class="input">
            <small>{{ $t('settings.applications.expiresAtHint') }}</small>
          </label>
          <p v-if="grantDialog.error" class="form-error">{{ grantDialog.error }}</p>
        </div>
        <footer class="dialog-actions">
          <button class="ghost-btn" :disabled="grantDialog.saving" @click="closeGrantDialog">
            {{ $t('settings.applications.cancel') }}
          </button>
          <button class="primary-btn" :disabled="grantDialog.saving" @click="saveGrant">
            {{ grantDialog.saving ? $t('settings.applications.saving') : $t('settings.applications.saveGrant') }}
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.apps-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 22px 24px 32px;
  background: var(--app-main-surface);
  color: var(--app-text);
}

.apps-panel,
.apps-panel * {
  box-sizing: border-box;
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.panel-heading h2 {
  margin: 0;
  font-size: 1.18rem;
  color: var(--app-text-strong);
}

.panel-heading p,
.section-hint {
  margin: 6px 0 0;
  color: var(--app-text-muted);
  font-size: 0.84rem;
  line-height: 1.5;
}

.panel-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.status-chip {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 5px 10px;
  border-radius: 999px;
  background: var(--app-success-soft);
  color: var(--app-success);
  font-size: 0.78rem;
}

.ghost-btn,
.primary-btn,
.mini-btn,
.icon-btn {
  border: 1px solid var(--app-border);
  border-radius: 9px;
  background: var(--app-panel-subtle);
  color: var(--app-text-soft);
  cursor: pointer;
  font: inherit;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}

.ghost-btn {
  padding: 8px 13px;
  font-size: 0.84rem;
}

.primary-btn {
  padding: 8px 16px;
  border-color: var(--app-accent);
  background: var(--app-accent);
  color: var(--app-on-accent);
  font-size: 0.84rem;
}

.mini-btn {
  padding: 4px 9px;
  font-size: 0.76rem;
}

.icon-btn {
  width: 30px;
  height: 30px;
  font-size: 1.1rem;
  line-height: 1;
}

.ghost-btn:hover,
.mini-btn:hover,
.icon-btn:hover {
  background: var(--app-panel-muted);
  color: var(--app-text);
}

.primary-btn:hover {
  background: var(--app-accent-strong);
}

.ghost-btn:disabled,
.primary-btn:disabled,
.mini-btn:disabled,
.icon-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.danger-btn {
  color: var(--app-danger);
  border-color: color-mix(in srgb, var(--app-danger) 35%, var(--app-border));
}

.state-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 220px;
  padding: 28px;
  border: 1px dashed var(--app-border);
  border-radius: 16px;
  color: var(--app-text-muted);
  text-align: center;
}

.error-state {
  border-color: color-mix(in srgb, var(--app-danger) 40%, var(--app-border));
  color: var(--app-danger);
}

.empty-state strong {
  color: var(--app-text);
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--app-border-strong);
  border-top-color: var(--app-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.app-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.app-card {
  border: 1px solid var(--app-border);
  border-radius: 16px;
  background: var(--app-panel);
  padding: 18px;
  box-shadow: 0 1px 0 color-mix(in srgb, var(--app-panel-strong) 60%, transparent) inset;
}

.app-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.app-identity {
  min-width: 0;
}

.app-name-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 9px;
}

.app-name-row h3 {
  margin: 0;
  font-size: 1rem;
  color: var(--app-text-strong);
}

.app-description {
  margin: 7px 0 0;
  color: var(--app-text-soft);
  font-size: 0.84rem;
  line-height: 1.5;
}

.app-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 7px 14px;
  margin-top: 10px;
  color: var(--app-text-muted);
  font-size: 0.76rem;
}

.app-meta b {
  margin-right: 4px;
  color: var(--app-text-faint);
  font-weight: 500;
}

.pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text-muted);
  font-size: 0.72rem;
  font-weight: 550;
  white-space: nowrap;
}

.pill-on,
.availability-available,
.audit-ok,
.audit-success {
  background: var(--app-success-soft);
  color: var(--app-success);
}

.pill-off,
.availability-disabled,
.audit-denied,
.audit-failed,
.audit-error {
  background: var(--app-danger-soft);
  color: var(--app-danger);
}

.availability-starting,
.audit-pending,
.audit-ask,
.audit-approval {
  background: var(--app-warning-soft);
  color: var(--app-warning);
}

.risk-read {
  background: var(--app-accent-soft);
  color: var(--app-accent);
}

.risk-write_reversible {
  background: var(--app-warning-soft);
  color: var(--app-warning);
}

.risk-write_destructive,
.risk-external_effect {
  background: var(--app-danger-soft);
  color: var(--app-danger);
}

.mode-allow {
  background: var(--app-success-soft);
  color: var(--app-success);
}

.mode-ask {
  background: var(--app-warning-soft);
  color: var(--app-warning);
}

.mode-deny {
  background: var(--app-danger-soft);
  color: var(--app-danger);
}

.toggle {
  position: relative;
  flex-shrink: 0;
  display: inline-flex;
  cursor: pointer;
}

.toggle input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.toggle-track {
  display: inline-flex;
  align-items: center;
  width: 40px;
  height: 22px;
  padding: 2px;
  border-radius: 999px;
  background: var(--app-panel-muted);
  border: 1px solid var(--app-border);
  transition: background 0.15s;
}

.toggle-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--app-text-muted);
  transition: transform 0.15s, background 0.15s;
}

.toggle input:checked + .toggle-track {
  background: var(--app-accent-soft);
  border-color: var(--app-accent);
}

.toggle input:checked + .toggle-track .toggle-thumb {
  transform: translateX(18px);
  background: var(--app-accent);
}

.toggle input:disabled + .toggle-track {
  opacity: 0.55;
  cursor: default;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 16px;
}

.section-head h4 {
  margin: 0;
  font-size: 0.86rem;
  color: var(--app-text-soft);
}

.table-wrap {
  margin-top: 8px;
  overflow-x: auto;
  border: 1px solid var(--app-border);
  border-radius: 11px;
}

.capability-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}

.capability-table th,
.capability-table td {
  padding: 9px 11px;
  text-align: left;
  vertical-align: middle;
  border-bottom: 1px solid var(--app-border);
}

.capability-table th {
  color: var(--app-text-faint);
  font-weight: 500;
  font-size: 0.74rem;
  white-space: nowrap;
  background: var(--app-panel-subtle);
}

.capability-table tbody tr:last-child td {
  border-bottom: none;
}

.capability-table code,
.grant-row code,
.audit-row code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem;
  color: var(--app-text-soft);
}

.cell-sub {
  display: block;
  margin-top: 3px;
  color: var(--app-text-faint);
  font-size: 0.72rem;
}

.scope-cell {
  max-width: 260px;
  color: var(--app-text-muted);
  font-size: 0.76rem;
}

.action-col {
  width: 1%;
  white-space: nowrap;
  text-align: right;
}

.grant-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 8px;
}

.grant-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 11px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel-subtle);
}

.grant-main,
.grant-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

.grant-scope,
.grant-meta {
  color: var(--app-text-muted);
  font-size: 0.75rem;
}

.muted {
  margin: 8px 0 0;
  color: var(--app-text-faint);
  font-size: 0.78rem;
}

.audit-section {
  border: 1px solid var(--app-border);
  border-radius: 16px;
  background: var(--app-panel-subtle);
  padding: 16px 18px 18px;
}

.audit-section .section-head {
  margin-top: 0;
}

.audit-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-top: 10px;
}

.audit-row {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr) auto 70px;
  align-items: center;
  gap: 10px;
  padding: 7px 4px;
  border-bottom: 1px solid var(--app-border);
  font-size: 0.77rem;
}

.audit-row:last-child {
  border-bottom: none;
}

.audit-time,
.audit-duration {
  color: var(--app-text-faint);
  font-size: 0.72rem;
  white-space: nowrap;
}

.audit-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
}

.audit-main strong {
  color: var(--app-text-soft);
  font-weight: 550;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.audit-duration {
  text-align: right;
}

.dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(4, 8, 15, 0.62);
  backdrop-filter: blur(3px);
}

.grant-dialog {
  width: min(460px, 100%);
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  border: 1px solid var(--app-border-strong);
  border-radius: 16px;
  background: var(--app-panel-strong);
  box-shadow: var(--app-shadow);
}

.dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 0;
}

.dialog-head h3 {
  margin: 0;
  font-size: 1rem;
  color: var(--app-text-strong);
}

.dialog-head p {
  margin: 4px 0 0;
  color: var(--app-text-muted);
  font-size: 0.8rem;
}

.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 13px;
  padding: 16px 18px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--app-text-soft);
  font-size: 0.82rem;
}

.field small {
  color: var(--app-text-faint);
  font-size: 0.72rem;
  line-height: 1.45;
}

.input {
  width: 100%;
  border: 1px solid var(--app-input-border);
  border-radius: 9px;
  background: var(--app-input-bg);
  color: var(--app-text);
  padding: 8px 10px;
  font: inherit;
  font-size: 0.84rem;
}

.input:focus {
  outline: none;
  border-color: var(--app-accent);
}

.form-error {
  margin: 0;
  color: var(--app-danger);
  font-size: 0.78rem;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
  padding: 0 18px 16px;
}

@media (max-width: 720px) {
  .apps-panel {
    padding: 16px;
  }

  .app-card-head {
    flex-direction: column;
  }

  .audit-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .audit-time {
    display: none;
  }
}
</style>
