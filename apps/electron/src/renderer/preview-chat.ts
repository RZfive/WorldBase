import { createApp, defineComponent, h, ref } from 'vue'
import '../style.css'
import { i18n } from './i18n'
import ConversationSidebar from './components/chat/layout/ConversationSidebar.vue'
import ChatHeader from './components/chat/layout/ChatHeader.vue'
import MessageList from './components/chat/messages/MessageList.vue'
import ChatInput from './components/chat/layout/ChatInput.vue'
import PinnedTodoPanel from './components/chat/layout/PinnedTodoPanel.vue'
import AuthPermissionPanel from './components/chat/layout/AuthPermissionPanel.vue'
import type { ChatMessage } from './components/chat/types'
import type { AgentSidebarItem, ConversationSidebarItem, GroupSidebarItem, LongTermGoalSidebarItem } from './components/chat/layout/ConversationSidebar.types'

document.documentElement.dataset.theme = 'light'
const agentItems: AgentSidebarItem[] = [{ id:'a1', conversationId:'c1', title:'前端工程师', subtitle:'settings 表格虚拟滚动 · 进行中', searchText:'', icon:'', modelId:'', providerName:'', modelOptions:[], isStreaming:true, pendingAuthCount:0, unreadCount:0, isActive:false }]
const groupItems: GroupSidebarItem[] = []
const goalItems: LongTermGoalSidebarItem[] = []
const conversationItems: ConversationSidebarItem[] = [
  { id:'c1', title:'settings 表格虚拟滚动', subtitle:'刚刚', searchText:'', icon:'', isStreaming:true, pendingAuthCount:0, unreadCount:0, isActive:true, isPinned:true },
  { id:'c2', title:'周报数据看板', subtitle:'昨天', searchText:'', icon:'', isStreaming:false, pendingAuthCount:0, unreadCount:0, isActive:false },
  { id:'c3', title:'登录跳转修复', subtitle:'9 月 15 日', searchText:'', icon:'', isStreaming:false, pendingAuthCount:0, unreadCount:0, isActive:false }
]
const messages: ChatMessage[] = [
  { id:'m1', role:'user', content:'把 settings 页的表格换成虚拟滚动。' },
  { id:'m2', role:'assistant', speakerName:'前端工程师', modelLabel:'Opus 4.8', content:'', blocks:[
    { id:'t1', kind:'thinking', text:'正在定位表格渲染瓶颈，并核对排序状态的存储位置。' },
    { id:'tool1', kind:'tool', toolRun:{ id:'r1', name:'read_current_page', status:'completed', progress:[{stage:'读取当前页面',detail:'定位到 settings/Table.vue'}] } },
    { id:'c21', kind:'content', content:'已定位瓶颈：1 万行全量 DOM。方案：只渲染可视区 ±10 行。' }
  ] },
  { id:'m3', role:'user', content:'排序状态切视图后会丢吗？' },
  { id:'m4', role:'assistant', speakerName:'前端工程师', modelLabel:'Opus 4.8', content:'排序与筛选写入 URL query，切回默认视图可恢复。\n\n```ts\nconst visibleRows = rows.slice(start, end)\n```' },
  { id:'m5', role:'user', content:'什么时候能看到性能数据？' },
  { id:'m6', role:'assistant', speakerName:'前端工程师', modelLabel:'Opus 4.8', content:'回归脚本跑完就发给你，预计 10 分钟内。' }
]

const App = defineComponent({
  setup () {
    const text = ref('')
    // ?busy=1 renders the running state (runtime bar + amber/stop key),
    // ?auth=1 additionally shows the auth strip in the attention zone —
    // handy for eyeballing the attention-zone anchoring against the
    // taller input card.
    const params = new URLSearchParams(window.location.search)
    const busy = params.get('busy') === '1'
    const auth = params.get('auth') === '1'
    const isLoading = busy || auth
    return () => h('div',{class:'preview-shell'},[
      h(ConversationSidebar,{agentItems,groupItems,longTermGoalItems:goalItems,conversationItems,conversationListLoaded:true,onNewConversation:()=>{},onToggleCollapse:()=>{},onSelectConversation:()=>{},onOpenAgent:()=>{},onOpenGroup:()=>{},onOpenLongTermGoal:()=>{},onNewLongTermGoal:()=>{},onDeleteLongTermGoal:()=>{},onDeleteConversation:()=>{},onRenameConversation:()=>{}}),
      h('main',{class:'preview-chat'},[
        h(ChatHeader,{contextLabel:'settings 表格虚拟滚动',contextDetail:'',availableChannelBindings:[],selectedChannelBindingId:'',providers:[{id:'anthropic',name:'Anthropic',models:['Opus 4.8']}],activeProviderId:'anthropic',selectedModel:'Opus 4.8',showProviderSelector:true,reasoningStrength:'high',temperature:null,providerDefaultTemperature:1,isGroupConversation:false,showAgentSelector:true,availableAgents:[{id:'a1',name:'前端工程师',icon:'🤖'},{id:'a2',name:'文案作者',icon:'✍️'}],selectedAgentId:'',onSelectProviderModel:()=>{},'onUpdate:reasoningStrength':()=>{},'onUpdate:temperature':()=>{},'onUpdate:selectedAgentId':()=>{}}),
        h(MessageList,{messages,isLoading:false,filePreview:{active:false,filePath:'',lineCount:0,added:0,removed:0},assistantName:'前端工程师'}),
        h('div',{class:'preview-attention'},[
          h(PinnedTodoPanel,{items:[{id:1,title:'定位表格渲染瓶颈',status:'completed'},{id:2,title:'实现虚拟滚动窗口',status:'in-progress'},{id:3,title:'补充性能回归数据',status:'not-started'}],isLoading:true}),
          ...(auth ? [h(AuthPermissionPanel,{request:{requestId:'r1',title:'运行命令',detail:'local_run_command · 只读'},pendingCount:1,onRespond:()=>{}})] : [])
        ]),
        h(ChatInput,{
          modelValue:text.value,'onUpdate:modelValue':(v:string)=>text.value=v,isLoading,pendingAuthCount:auth?1:0,pendingImages:[],pendingFiles:[],isUploadingFiles:false,uploadFeedback:'',documentDockVisible:false,folderWorkspaceVisible:false,authMode:'strict',planModeActive:false,computerUseEnabled:false,computerUsePermissionGranted:true,availableSkills:[{id:'s1',name:'网页开发'},{id:'s2',name:'代码审查'}],activeSkillIds:new Set(['s1']),showSkillPicker:false,isGroupConversation:false,onSend:()=>{},onStop:()=>{},onAddAttachments:()=>{},onRemoveImage:()=>{},onRemoveFile:()=>{},onToggleDocumentDock:()=>{},onToggleFolderWorkspace:()=>{},'onUpdate:authMode':()=>{},onTogglePlanMode:()=>{},onToggleComputerUse:()=>{},onToggleSkillPicker:()=>{},onSelectAllSkills:()=>{},onClearSkills:()=>{},onToggleSkill:()=>{}
        })
      ])
    ])
  }
})
const app=createApp(App); app.use(i18n); app.mount('#app')

// Track the input card height like ChatPanelContainer does, so the
// attention zone keeps floating 6px above the card as it grows/shrinks.
const surface = document.querySelector<HTMLElement>('.preview-chat')
const inputCard = surface?.querySelector<HTMLElement>('.input-container')
if (surface && inputCard && typeof ResizeObserver !== 'undefined') {
  const sync = () => surface.style.setProperty('--chat-input-card-height', `${inputCard.offsetHeight}px`)
  new ResizeObserver(sync).observe(inputCard)
  sync()
}

const style=document.createElement('style'); style.textContent=`
html,body,#app{height:100%;overflow:hidden}.preview-shell{display:flex;height:100%;background:var(--app-main-surface)}.preview-shell>.conv-sidebar{width:224px;flex:0 0 224px}.preview-chat{--chat-message-gutter:clamp(24px,4vw,64px);--chat-message-track-max:980px;--chat-user-message-max:680px;--chat-user-bubble-max:540px;--chat-event-card-max:100%;--chat-input-overlap:72px;--chat-input-gutter:16px;--chat-input-card-height:132px;position:relative;display:flex;flex:1;min-width:640px;min-height:0;flex-direction:column;overflow:hidden;background:var(--app-chat-canvas)}.preview-attention{position:absolute;left:16px;right:16px;bottom:calc(var(--chat-input-card-height,132px) + 24px);z-index:8;pointer-events:none}.preview-attention>*{width:100%}
`; document.head.appendChild(style)
