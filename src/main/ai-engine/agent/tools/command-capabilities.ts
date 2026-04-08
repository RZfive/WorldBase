export const PROJECT_COMMAND_WHITELIST = [
  'npm', 'npx', 'node', 'git', 'ls', 'cat', 'echo', 'pwd', 'find', 'grep', 'head', 'tail', 'wc'
]

export const LOCAL_COMMAND_DISCOVERY_CANDIDATES = [
  'node', 'npm', 'npx', 'pnpm', 'git',
  'python', 'python3', 'pip', 'pip3',
  'bash', 'sh', 'zsh',
  'pwsh', 'powershell', 'cmd',
  'ls', 'cat', 'grep', 'find', 'head', 'tail', 'wc', 'echo', 'pwd',
  'curl', 'wget'
]
