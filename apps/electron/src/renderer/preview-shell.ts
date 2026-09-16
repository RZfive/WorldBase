import { createApp, defineComponent, h, ref } from 'vue'
import '../style.css'
import { i18n } from './i18n'
import TitleBar from './components/app/TitleBar.vue'
import DockBar from './components/app/DockBar.vue'

interface PreviewApp {
  id: string
  name: string
  kind: 'project' | 'browser'
  type: string
  icon?: string
  url?: string
  port?: number
  isWindow: boolean
  closable?: boolean
  savedToLaunchpad?: boolean
  pinned?: boolean
  isRunning?: boolean
}

// Static harness for the app shell chrome (design v1.7 titlebar + dock).
// Serve with `pnpm dev` and open /preview-shell.html.

document.documentElement.dataset.theme = 'light'

const runningApps = new Map<string, PreviewApp>([
  ['w1', { id: 'w1', name: 'WorldBase Web', kind: 'browser', type: 'browser', isWindow: false, isRunning: true, closable: true }],
  ['a2', { id: 'a2', name: 'Admin Console', kind: 'project', type: 'frontend', isWindow: false, isRunning: true, closable: true }]
])

const pinnedApps: PreviewApp[] = [
  { id: 'p1', name: '数据看板', kind: 'project', type: 'fullstack', isWindow: true, pinned: true, isRunning: true, closable: true }
]

const App = defineComponent({
  setup () {
    const currentView = ref<'chat' | 'app' | 'source' | 'settings' | 'studio'>('chat')
    const showLaunchpad = ref(false)
    return () => h('div', { class: 'shell' }, [
      h(TitleBar, {
        viewLabel: '对话',
        contextTitle: 'settings 表格虚拟滚动',
        onMinimize: () => {},
        onMaximize: () => {},
        onClose: () => {}
      }),
      h('div', { class: 'body' }, [
        h(DockBar, {
          currentView: currentView.value,
          showLaunchpad: showLaunchpad.value,
          runningApps,
          pinnedApps,
          embeddedProjectId: null,
          onOpenChat: () => { currentView.value = 'chat' },
          onOpenStudio: () => { currentView.value = 'studio' },
          onToggleLaunchpad: () => { showLaunchpad.value = !showLaunchpad.value },
          onOpenSettings: () => { currentView.value = 'settings' },
          onSwitchToApp: () => { currentView.value = 'app' },
          onCloseApp: () => {},
          onContextMenu: () => {}
        }),
        h('main', { class: 'main' })
      ])
    ])
  }
})

const app = createApp(App)
app.use(i18n)
app.mount('#app')

const style = document.createElement('style')
style.textContent = `
html,body,#app{height:100%;overflow:hidden}
.shell{display:flex;flex-direction:column;height:100%;background:var(--app-chat-canvas);--dock-width:56px}
.body{display:flex;flex:1;min-height:0}
.main{flex:1}
`
document.head.appendChild(style)
