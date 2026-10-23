export interface CodingTaskDetection {
  isCoding: boolean
  reason: string
}

const ACTION_PATTERN = /(?:修复|实现|重构|修改|添加|删除|更新|优化|调试|排查|定位|测试|构建|编译|部署|运行|写|改|查|看|\b(?:fix|implement|refactor|update|add|remove|delete|debug|investigate|test|build|compile|deploy|run)\b)/i
const CODE_CONTEXT_PATTERN = /(?:代码|文件|函数|组件|接口|页面|样式|按钮|脚本|项目|仓库|分支|类型|报错|错误|崩溃|\b(?:bug|code|file|function|component|page|style|button|script|project|repo|branch|type|error|crash|test)\b)/i
const CODE_FENCE_PATTERN = /```/
const CODE_TAG_PATTERN = /\[\[(?:code|project):[^\]]*\]\]/i
const FILE_PATH_PATTERN = /(?:^|[\s"'`([{])(?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|vue|py|go|java|rs|rb|php|c|cc|cpp|h|hpp|cs|swift|kt|kts|json|yaml|yml|toml|xml|gradle|sql|sh|bash|zsh)(?=$|[\s"'`)\]},:;])/i
const SINGLE_EXTENSION_PATTERN = /(?:^|[\s"'`([{])\.(?:vue|tsx?|jsx?|py|go|java|rs|json|yaml|yml|toml|xml|sql|sh)(?=$|[\s"'`)\]},:;])/i
const ERROR_PATTERN = /(?:\b(?:TypeError|ReferenceError|SyntaxError|RangeError):|\bat\s+\S+\s*\(|\bTS\d{4}\b|\bESLint\b|\bnpm\s+ERR!|\berror\s+TS\d+\b)/i

function hasStrongCodeSignal (text: string): boolean {
  return CODE_FENCE_PATTERN.test(text) ||
    CODE_TAG_PATTERN.test(text) ||
    FILE_PATH_PATTERN.test(text) ||
    SINGLE_EXTENSION_PATTERN.test(text) ||
    ERROR_PATTERN.test(text)
}

export function detectCodingTask (text: string): CodingTaskDetection {
  const normalizedText = text.trim()

  if (hasStrongCodeSignal(normalizedText)) {
    return { isCoding: true, reason: 'strong code signal' }
  }

  if (ACTION_PATTERN.test(normalizedText) && CODE_CONTEXT_PATTERN.test(normalizedText)) {
    return { isCoding: true, reason: 'action with code context' }
  }

  return { isCoding: false, reason: 'no coding signals' }
}

export function isCodingTaskText (text: string): boolean {
  return detectCodingTask(text).isCoding
}
