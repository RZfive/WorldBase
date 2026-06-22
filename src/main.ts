import { createApp } from 'vue'
import './style.css'
import 'katex/dist/katex.min.css'
import App from './App.vue'
import { i18n, setLocale } from './renderer/i18n'
import { loadLocalePreference } from './renderer/utils/locale'

const app = createApp(App)
app.use(i18n)
app.mount('#app')

// Reconcile the initial (localStorage-cached) locale against the authoritative
// Electron-backed preference once IPC is ready, so a cold start on a machine
// where the preference was changed elsewhere still ends up correct.
void loadLocalePreference().then(preference => {
  setLocale(preference)
}).catch(() => {
  // Keep the cached locale on failure.
})
