export interface CodingTaskDetection {
  isCoding: boolean
  reason: string
}

export type WorkIntent = 'coding' | 'document' | 'normal'

export interface WorkIntentDetection {
  intent: WorkIntent
  coding: boolean
  reason: string
}

const ACTION_PATTERN = /(?:修复|实现|重构|修改|添加|删除|更新|优化|调试|排查|定位|测试|构建|编译|部署|运行|写|改|查|看|\b(?:fix|implement|refactor|update|add|remove|delete|debug|investigate|test|build|compile|deploy|run)\b)/i
const CODE_CONTEXT_PATTERN = /(?:代码|文件|函数|组件|接口|页面|样式|按钮|脚本|项目|仓库|分支|类型|报错|错误|崩溃|\b(?:bug|code|file|function|component|page|style|button|script|project|repo|branch|type|error|crash|test)\b)/i
const CODE_FENCE_PATTERN = /```/
const CODE_TAG_PATTERN = /\[\[(?:code|project):[^\]]*\]\]/i
const FILE_PATH_PATTERN = /(?:^|[\s"'`([{])(?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|mts|cts|jsx?|mjs|cjs|vue|svelte|astro|pyi?|go|java|kt|kts|scala|rs|rb|php|cs|fsx?|c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|swift|dart|jsonc?|json5|ya?ml|toml|ini|cfg|conf|xml|plist|gradle|properties|html?|css|scss|sass|less|sql|graphql|gql|sh|bash|zsh|fish|ps1|bat|cmd|lua|r|pl|exs?|erl|hrl|cljs?|groovy|sol|zig|nim|v)(?=$|[\s"'`)\]},:;])/i
const SINGLE_EXTENSION_PATTERN = /(?:^|[\s"'`([{])\.(?:tsx?|mts|cts|jsx?|mjs|cjs|vue|svelte|astro|pyi?|go|java|kt|kts|scala|rs|rb|php|cs|fsx?|c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|swift|dart|jsonc?|json5|ya?ml|toml|ini|cfg|conf|xml|plist|gradle|properties|html?|css|scss|sass|less|sql|graphql|gql|sh|bash|zsh|fish|ps1|bat|cmd|lua|r|pl|exs?|erl|hrl|cljs?|groovy|sol|zig|nim|v)(?=$|[\s"'`)\]},:;])/i
const ERROR_PATTERN = /(?:\b(?:TypeError|ReferenceError|SyntaxError|RangeError):|\bat\s+\S+\s*\(|\bTS\d{4}\b|\bESLint\b|\bnpm\s+ERR!|\berror\s+TS\d+\b)/i

const DOCUMENT_OBJECT_PATTERN = /(?:^|[^\w])(?:pdf|word|excel|ppt|powerpoint|document|docx?|xlsx?|pptx?|spreadsheet|slides?|presentation|report|resume|contract)(?=$|[^\w])|幻灯片|演示文稿|文档|表格|报告|简历|合同|论文|说明书/i
const DOCUMENT_EDIT_ACTION_PATTERN = /(?:润色|翻译|总结|摘要|排版|格式|校对|改写|修改|更新|插入|删除|替换|读取|整理|生成|编辑|添加|调整|合并|拆分|提取|转换|转成|转为|导出|改|\b(?:edit|update|insert|delete|remove|replace|read|organize|organise|generate|polish|translate|summari[sz]e|format|rewrite|revise|proofread|convert|export)\b)/i
const DOCUMENT_ONLY_ACTION_PATTERN = /(?:润色|翻译|总结|摘要|排版|格式|校对|改写|\b(?:polish|translate|summari[sz]e|proofread|rewrite)\b)/i

function hasStrongCodeSignal (text: string): boolean {
  return CODE_FENCE_PATTERN.test(text) ||
    CODE_TAG_PATTERN.test(text) ||
    FILE_PATH_PATTERN.test(text) ||
    SINGLE_EXTENSION_PATTERN.test(text) ||
    ERROR_PATTERN.test(text)
}

function hasDocumentIntent (text: string): boolean {
  if (DOCUMENT_OBJECT_PATTERN.test(text) && DOCUMENT_EDIT_ACTION_PATTERN.test(text)) {
    return true
  }

  // A document-only action ("润色", "翻译", ...) is enough on its own, unless
  // the text also points at a code object.
  return DOCUMENT_ONLY_ACTION_PATTERN.test(text) && !CODE_CONTEXT_PATTERN.test(text)
}

export function detectWorkIntent (text: string): WorkIntentDetection {
  const normalizedText = text.trim()

  if (hasStrongCodeSignal(normalizedText)) {
    return { intent: 'coding', coding: true, reason: 'strong code signal' }
  }

  if (hasDocumentIntent(normalizedText)) {
    return { intent: 'document', coding: false, reason: 'document work signal' }
  }

  if (ACTION_PATTERN.test(normalizedText) && CODE_CONTEXT_PATTERN.test(normalizedText)) {
    return { intent: 'coding', coding: true, reason: 'action with code context' }
  }

  return { intent: 'normal', coding: false, reason: 'no coding signals' }
}

export function isDocumentTaskText (text: string): boolean {
  return detectWorkIntent(text).intent === 'document'
}

export function detectCodingTask (text: string): CodingTaskDetection {
  const detection = detectWorkIntent(text)

  if (detection.intent === 'coding') {
    return { isCoding: true, reason: detection.reason }
  }

  return { isCoding: false, reason: 'no coding signals' }
}

export function isCodingTaskText (text: string): boolean {
  return detectCodingTask(text).isCoding
}
