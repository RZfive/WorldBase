import { buildDocumentRenderPreview } from '../../../src/main/document-preview/document-render-service.js'
import { t } from '../../../src/main/i18n/main-i18n.js'
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
      error: t('mainDialog.documentPreviewFallbackError', { message: (error as Error).message || String(error) }),
      generatedAt: new Date().toISOString()
    }
  }

  return artifact
}
