import { createApp, h, ref, onMounted } from 'vue'
import '../style.css'
import { i18n } from './i18n'
import ConversationSidebar from './components/chat/layout/ConversationSidebar.vue'
import type { AgentSidebarItem, ConversationSidebarItem, GroupSidebarItem, LongTermGoalSidebarItem } from './components/chat/layout/ConversationSidebar.types'

const agentItems: AgentSidebarItem[] = [
  {
    id: 'a1', conversationId: 'c1', title: '前端工程师', subtitle: 'settings 表格虚拟滚动 · 进行中', searchText: '',
    icon: '', modelId: '', providerName: '', modelOptions: [], isStreaming: true,
    pendingAuthCount: 0, unreadCount: 0, isActive: false
  }
]

const groupItems: GroupSidebarItem[] = [
  {
    id: 'g1', conversationId: 'c3', title: '产品评审群', subtitle: '第 3 轮 · 3 位参与者', searchText: '',
    icon: '', isStreaming: false, pendingAuthCount: 0, unreadCount: 2, isActive: false
  }
]

const goalItems: LongTermGoalSidebarItem[] = [
  {
    id: 'goal1', title: '性能优化专项', subtitle: '进行中 · 2 个关联会话', searchText: '', icon: '',
    status: 'active', isRunning: true, needsUserInput: false, isStreaming: true,
    pendingAuthCount: 0, unreadCount: 0, isActive: false
  }
]

const conversationItems: ConversationSidebarItem[] = Array.from({ length: 30 }, (_, i) => ({
  id: `c-${i}`,
  title: `测试会话 ${String(i + 1).padStart(2, '0')} · settings 表格虚拟滚动与排序状态持久化`,
  subtitle: `9 月 ${(i % 28) + 1} 日`,
  searchText: '',
  icon: '',
  isStreaming: i === 4,
  pendingAuthCount: i === 7 ? 2 : 0,
  unreadCount: i === 9 ? 3 : 0,
  isActive: i === 2,
  isPinned: i === 0
}))

const collapsed = ref(window.location.hash.includes('collapsed'))

const ScrollProbe = {
  setup () {
    onMounted(() => {
      const m = window.location.hash.match(/scroll=(\d+)/)
      if (m) {
        const el = document.querySelector('.conv-list') as HTMLElement | null
        if (el) el.scrollTop = Number(m[1])
      }
      if (window.location.hash.includes('measure')) {
        requestAnimationFrame(() => {
          const list = document.querySelector('.conv-list')
          const section = document.querySelector('.conv-section')
          const body = document.querySelector('.conv-section-body')
          const inner = document.querySelector('.conv-section-body-inner')
          const item = document.querySelector('.conversation-item-compact')
          const title = document.querySelector('.conversation-item-compact .conv-title')
          const row = document.querySelector('.conv-toolbar-row')
          const g = (el: Element | null) => el ? `${(el as HTMLElement).offsetWidth}` : 'x'
          const marker = document.createElement('div')
          marker.setAttribute('data-measure', [
            `list=${g(list)}`,
            `section=${g(section)}`,
            `body=${g(body)}`,
            `inner=${g(inner)}`,
            `item=${g(item)}`,
            `title=${g(title)}`,
            `toolbar=${g(row)}`,
            `bodyCS=${body ? getComputedStyle(body).maxWidth + '/' + getComputedStyle(body).marginLeft : 'x'}`
          ].join(' '))
          document.body.appendChild(marker)
        })
      }
    })
    return () => null
  }
}

const app = createApp({
  setup () {
    return () => h('div', { style: 'display:flex;height:100vh;background:var(--app-main-surface)' }, [
      h(ScrollProbe),
      h('aside', { style: 'position:relative' }, [
        h('div', { style: `position:relative;display:flex;height:100%;transition:width .22s ease;overflow:visible;${collapsed.value ? 'width:0;flex-basis:0' : 'width:252px;flex-basis:252px'}` }, [
          collapsed.value
            ? null
            : h(ConversationSidebar, {
              agentItems,
              groupItems,
              longTermGoalItems: goalItems,
              conversationItems,
              conversationListLoaded: true,
              onToggleCollapse: () => { collapsed.value = true },
              onNewConversation: () => {},
              onSelectConversation: () => {},
              onOpenAgent: () => {},
              onOpenGroup: () => {},
              onOpenLongTermGoal: () => {}
            })
        ])
      ]),
      h('main', { style: 'flex:1;display:flex;align-items:center;justify-content:center;color:var(--app-text-faint);font-size:13px' }, '对话区（占位）')
    ])
  }
})

app.use(i18n)
app.mount(document.getElementById('app')!)
