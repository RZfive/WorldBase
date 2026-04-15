import { getNextRuntimeCompatibilityProfile } from '../../project-runtime/next-runtime-compat.js'

type JsonRecord = Record<string, unknown>

const STARTER_MERMAID_DIAGRAM = `\`\`\`mermaid
flowchart TD
  U[User] --> UI[Next.js App Router UI]
  UI --> Layout[app/layout.(js|tsx)]
  UI --> Page[app/page.(js|tsx)]
  Layout --> Styles[app/globals.css]
  Page --> Components[Reusable UI sections]
  Components --> HostAPI[The World host APIs / data endpoints]
  Build[package.json scripts] --> NextBuild[next build]
  NextBuild --> Standalone[.next/standalone/server.js]
  Meta[.world-meta.json runtime.backend.command] --> Standalone
\`\`\``

const JS_LAYOUT_TEMPLATE = `import './globals.css'

export const metadata = {
  title: 'The World App',
  description: 'Generated from The World base template'
}

export default function RootLayout ({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
`

const TS_LAYOUT_TEMPLATE = `import './globals.css'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = {
  title: 'The World App',
  description: 'Generated from The World base template'
}

export default function RootLayout ({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
`

const JS_PAGE_TEMPLATE = `const highlights = [
  {
    title: 'Fast customization',
    description: 'Update this starter page with the user’s real modules, content, and actions.'
  },
  {
    title: 'Built-in styling',
    description: 'Global tokens and responsive layout are ready so the app does not render unstyled.'
  },
  {
    title: 'Runtime ready',
    description: 'Keep the Next.js App Router structure so build and startup stay compatible with The World.'
  }
]

export default function HomePage () {
  return (
    <main className="page-shell">
      <section className="hero-card">
        <span className="eyebrow">The World starter template</span>
        <h1>Start from a working Next.js baseline</h1>
        <p className="hero-copy">
          Replace this content with the requested product experience while keeping the starter structure intact.
        </p>
      </section>

      <section className="feature-grid">
        {highlights.map(item => (
          <article key={item.title} className="feature-card">
            <h2>{item.title}</h2>
            <p>{item.description}</p>
          </article>
        ))}
      </section>
    </main>
  )
}
`

const TS_PAGE_TEMPLATE = `const highlights = [
  {
    title: 'Fast customization',
    description: 'Update this starter page with the user’s real modules, content, and actions.'
  },
  {
    title: 'Built-in styling',
    description: 'Global tokens and responsive layout are ready so the app does not render unstyled.'
  },
  {
    title: 'Runtime ready',
    description: 'Keep the Next.js App Router structure so build and startup stay compatible with The World.'
  }
]

export default function HomePage () {
  return (
    <main className="page-shell">
      <section className="hero-card">
        <span className="eyebrow">The World starter template</span>
        <h1>Start from a working Next.js baseline</h1>
        <p className="hero-copy">
          Replace this content with the requested product experience while keeping the starter structure intact.
        </p>
      </section>

      <section className="feature-grid">
        {highlights.map(item => (
          <article key={item.title} className="feature-card">
            <h2>{item.title}</h2>
            <p>{item.description}</p>
          </article>
        ))}
      </section>
    </main>
  )
}
`

const GLOBALS_CSS_TEMPLATE = `:root {
  color-scheme: light;
  --background: #f4f7fb;
  --surface: rgba(255, 255, 255, 0.9);
  --surface-strong: #ffffff;
  --text: #172033;
  --muted: #5f6b85;
  --border: rgba(15, 23, 42, 0.08);
  --shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
  --accent: #3b82f6;
  --accent-strong: #1d4ed8;
  --radius-lg: 24px;
  --radius-md: 18px;
}

* {
  box-sizing: border-box;
}

html {
  font-size: 16px;
}

html,
body {
  margin: 0;
  min-height: 100%;
  font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background:
    radial-gradient(circle at top, rgba(59, 130, 246, 0.16), transparent 34%),
    linear-gradient(180deg, #f8fbff 0%, var(--background) 100%);
  color: var(--text);
}

body {
  min-height: 100vh;
}

a {
  color: inherit;
  text-decoration: none;
}

button,
input,
select,
textarea {
  font: inherit;
}

.page-shell {
  width: min(1100px, calc(100vw - 48px));
  margin: 0 auto;
  padding: 48px 0 72px;
}

.hero-card,
.feature-card {
  border: 1px solid var(--border);
  background: var(--surface);
  backdrop-filter: blur(12px);
  box-shadow: var(--shadow);
}

.hero-card {
  padding: 32px;
  border-radius: var(--radius-lg);
}

.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 999px;
  background: rgba(59, 130, 246, 0.12);
  color: var(--accent-strong);
  font-size: 0.875rem;
  font-weight: 700;
}

.hero-card h1 {
  margin: 18px 0 12px;
  font-size: clamp(2rem, 4vw, 3.5rem);
  line-height: 1.05;
}

.hero-copy {
  margin: 0;
  max-width: 720px;
  color: var(--muted);
  font-size: 1.05rem;
  line-height: 1.7;
}

.feature-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
  margin-top: 24px;
}

.feature-card {
  padding: 24px;
  border-radius: var(--radius-md);
}

.feature-card h2 {
  margin: 0 0 12px;
  font-size: 1.05rem;
}

.feature-card p {
  margin: 0;
  color: var(--muted);
  line-height: 1.65;
}

@media (max-width: 900px) {
  .page-shell {
    width: min(100vw - 32px, 1100px);
    padding-top: 32px;
  }

  .feature-grid {
    grid-template-columns: 1fr;
  }
}
`

function isRecord (value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function detectNextJsProject (files: Record<string, string>, meta: JsonRecord): boolean {
  if (meta.framework === 'nextjs' || files['next.config.js'] || files['next.config.mjs'] || files['next.config.ts']) {
    return true
  }

  if (!files['package.json']) {
    return false
  }

  try {
    const packageJson = JSON.parse(files['package.json']) as JsonRecord
    const dependencies = isRecord(packageJson.dependencies) ? packageJson.dependencies : {}
    const devDependencies = isRecord(packageJson.devDependencies) ? packageJson.devDependencies : {}
    return typeof dependencies.next === 'string' || typeof devDependencies.next === 'string'
  } catch {
    return false
  }
}

function hasTypeScriptSources (files: Record<string, string>): boolean {
  return Object.keys(files).some(filePath => filePath.endsWith('.ts') || filePath.endsWith('.tsx'))
}

function resolveAppRoot (files: Record<string, string>): 'app' | 'src/app' {
  return Object.keys(files).some(filePath => filePath.startsWith('src/app/')) ? 'src/app' : 'app'
}

function parseLeadingMajorVersion (versionRange: string): number {
  const match = versionRange.match(/(\d+)/)
  return match ? (Number.parseInt(match[1], 10) || 0) : 0
}

function findRootAppFile (
  files: Record<string, string>,
  appRoot: 'app' | 'src/app',
  baseName: 'layout' | 'page'
): string | undefined {
  const candidates = [
    `${appRoot}/${baseName}.js`,
    `${appRoot}/${baseName}.jsx`,
    `${appRoot}/${baseName}.ts`,
    `${appRoot}/${baseName}.tsx`
  ]

  return candidates.find(filePath => filePath in files)
}

function withGlobalsImport (source: string): string {
  if (source.includes("'./globals.css'") || source.includes('"./globals.css"')) {
    return source
  }

  const useClientMatch = source.match(/^(['"])use client\1\s*;?/)
  if (!useClientMatch) {
    return `import './globals.css'\n\n${source.trimStart()}`
  }

  const prefix = useClientMatch[0]
  const remainder = source.slice(prefix.length).trimStart()
  return `${prefix}\nimport './globals.css'\n\n${remainder}`
}

function getStarterTypeScriptDevDependencies (profile: ReturnType<typeof getNextRuntimeCompatibilityProfile>): Record<string, string> {
  const reactMajor = Math.max(parseLeadingMajorVersion(profile.reactVersionRange), 18)
  const nodeMajor = Math.max(parseLeadingMajorVersion(profile.minimumNodeVersion), 18)

  return {
    typescript: '^5.0.0',
    '@types/node': `^${nodeMajor}.0.0`,
    '@types/react': `^${reactMajor}.0.0`
  }
}

export function getNextJsStarterArchitectureDescription (): string {
  return [
    'Use the built-in Next.js starter template as the base for every generated app and only modify the files that need to change.',
    '- Runtime layer: package.json provides npm run build / npm start, next.config.js enables standalone output, and .world-meta.json points runtime.backend.command to node .next/standalone/server.js.',
    '- App shell: app/layout.(js|tsx) is the only root layout entry and must import app/globals.css.',
    '- Page entry: app/page.(js|tsx) is the initial screen and should be replaced with the requested product UI instead of deleted without a replacement.',
    '- Styling layer: app/globals.css contains resets, design tokens, spacing, and responsive defaults so generated apps never launch without styles.',
    '- Data layer: browser components call The World host APIs and project data endpoints instead of creating their own local infrastructure.',
    '- Persistence rule: any app that needs data saving must declare tables in .world-meta.json dataSchema and use The World host SQLite APIs only.',
    '- Forbidden persistence patterns: do not add better-sqlite3, sqlite3, Prisma, Drizzle, Sequelize, TypeORM, custom SQLite bootstrap code, or ad hoc local file storage for business data.',
    '',
    'Template architecture diagram:',
    STARTER_MERMAID_DIAGRAM
  ].join('\n')
}

export function applyNextJsStarterTemplate (
  files: Record<string, string>,
  meta: JsonRecord,
  nodeVersion = process.versions.node
): { files: Record<string, string>; meta: JsonRecord; templateApplied: boolean } {
  if (!detectNextJsProject(files, meta)) {
    return { files, meta, templateApplied: false }
  }

  const profile = getNextRuntimeCompatibilityProfile(nodeVersion)
  const starterTypeScriptDevDependencies = getStarterTypeScriptDevDependencies(profile)
  const nextFiles = { ...files }
  const usesTypeScript = hasTypeScriptSources(nextFiles)
  const appRoot = resolveAppRoot(nextFiles)
  const layoutPath = `${appRoot}/layout.${usesTypeScript ? 'tsx' : 'js'}`
  const pagePath = `${appRoot}/page.${usesTypeScript ? 'tsx' : 'js'}`
  const globalsPath = `${appRoot}/globals.css`

  if (!nextFiles['package.json']) {
    nextFiles['package.json'] = `${JSON.stringify({
      name: 'the-world-generated-app',
      private: true,
      scripts: {
        dev: 'next dev',
        build: 'next build',
        start: 'next start'
      },
      dependencies: {
        next: profile.nextVersionRange,
        react: profile.reactVersionRange,
        'react-dom': profile.reactDomVersionRange
      }
    }, null, 2)}\n`
  } else {
    try {
      const packageJson = JSON.parse(nextFiles['package.json']) as JsonRecord
      const scripts = isRecord(packageJson.scripts) ? { ...packageJson.scripts } : {}
      const dependencies = isRecord(packageJson.dependencies) ? { ...packageJson.dependencies } : {}
      const devDependencies = isRecord(packageJson.devDependencies) ? { ...packageJson.devDependencies } : {}

      scripts.dev = typeof scripts.dev === 'string' ? scripts.dev : 'next dev'
      scripts.build = 'next build'
      scripts.start = 'next start'

      dependencies.next = profile.nextVersionRange
      dependencies.react = profile.reactVersionRange
      dependencies['react-dom'] = profile.reactDomVersionRange

      if (usesTypeScript) {
        for (const [dependencyName, dependencyVersion] of Object.entries(starterTypeScriptDevDependencies)) {
          devDependencies[dependencyName] = devDependencies[dependencyName] ?? dependencyVersion
        }
      }

      nextFiles['package.json'] = `${JSON.stringify({
        ...packageJson,
        private: packageJson.private ?? true,
        scripts,
        dependencies,
        ...(Object.keys(devDependencies).length > 0 ? { devDependencies } : {})
      }, null, 2)}\n`
    } catch {
      // Leave invalid package.json untouched for later validation feedback.
    }
  }

  const existingLayoutPath = findRootAppFile(nextFiles, appRoot, 'layout')
  if (existingLayoutPath) {
    nextFiles[existingLayoutPath] = withGlobalsImport(nextFiles[existingLayoutPath])
  } else {
    nextFiles[layoutPath] = usesTypeScript ? TS_LAYOUT_TEMPLATE : JS_LAYOUT_TEMPLATE
  }

  if (!findRootAppFile(nextFiles, appRoot, 'page')) {
    nextFiles[pagePath] = usesTypeScript ? TS_PAGE_TEMPLATE : JS_PAGE_TEMPLATE
  }

  if (!nextFiles[globalsPath]) {
    nextFiles[globalsPath] = GLOBALS_CSS_TEMPLATE
  }

  if (!nextFiles['next.config.js'] && !nextFiles['next.config.mjs'] && !nextFiles['next.config.ts'] && !nextFiles['next.config.cjs']) {
    nextFiles['next.config.js'] = `/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone'
}

module.exports = nextConfig
`
  }

  return {
    files: nextFiles,
    meta: {
      ...meta,
      framework: 'nextjs'
    },
    templateApplied: true
  }
}
