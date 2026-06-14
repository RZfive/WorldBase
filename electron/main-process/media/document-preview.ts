import { buildDocumentRenderPreview } from '../../../src/main/document-preview/document-render-service.js'
import { mainState } from '../state.js'

export async function ensureDocumentRenderPreview (artifactId: string) {
  const artifact = mainState.documentStore!.getArtifact(artifactId)
  if (!artifact) return null

  if (artifact.render?.status === 'ready') {
    return artifact
  }

  try {
    artifact.render = await buildDocumentRenderPreview(artifact.filePath, artifact.fileType)
  } catch (error) {
    artifact.render = {
      kind: 'structured',
      source: 'fallback',
      status: 'unavailable',
      error: `真实预览生成失败，已回退到结构化视图: ${(error as Error).message || String(error)}`,
      generatedAt: new Date().toISOString()
    }
  }

  return artifact
}
