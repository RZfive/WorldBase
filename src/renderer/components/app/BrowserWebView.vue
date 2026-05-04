<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { resolveProjectIcon } from "../../utils/project-icon";
import type {
  BrowserAutomationAction,
  BrowserAutomationActionResult,
  BrowserAutomationSnapshot,
} from "../../../shared/page-automation-types.js";

interface BrowserAppStatePayload {
  appId: string;
  url: string;
  title: string;
  icon?: string;
}

interface BrowserContextMenuPayload {
  appId: string;
  x: number;
  y: number;
}

interface WebviewLikeElement extends HTMLElement {
  src: string;
  getURL: () => string;
  loadURL?: (url: string) => void;
  executeJavaScript?: <T>(code: string, userGesture?: boolean) => Promise<T>;
}

const props = defineProps<{
  appId: string;
  url: string;
  title: string;
  icon?: string;
}>();

const emit = defineEmits<{
  (e: "stateChange", payload: BrowserAppStatePayload): void;
  (e: "contextMenu", payload: BrowserContextMenuPayload): void;
}>();

const webviewRef = ref<WebviewLikeElement | null>(null);
const currentUrl = ref(props.url);
const currentTitle = ref(props.title);
const currentIcon = ref(props.icon);

const resolvedIcon = computed(() =>
  resolveProjectIcon("browser", currentIcon.value),
);

async function executeInPage<T>(runner: string, payload?: unknown): Promise<T> {
  const webview = webviewRef.value;
  if (!webview || typeof webview.executeJavaScript !== "function") {
    throw new Error("Browser automation is unavailable for this page surface.");
  }

  return await webview.executeJavaScript<T>(
    `(() => {
      const payload = ${JSON.stringify(payload ?? null)};
      ${runner}
    })()`,
    true,
  );
}

async function captureAutomationSnapshot(): Promise<BrowserAutomationSnapshot> {
  return await executeInPage<BrowserAutomationSnapshot>(`
    const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const buildSelector = (element) => {
      if (!(element instanceof Element)) return null;
      if (element.id) return '#' + CSS.escape(element.id);

      const tokens = [
        ['data-testid', element.getAttribute('data-testid')],
        ['data-test', element.getAttribute('data-test')],
        ['name', element.getAttribute('name')],
        ['aria-label', element.getAttribute('aria-label')],
      ].filter((entry) => entry[1]);

      if (tokens.length > 0) {
        const [attribute, value] = tokens[0];
        return element.tagName.toLowerCase() + '[' + attribute + '="' + CSS.escape(value) + '"]';
      }

      const path = [];
      let node = element;
      while (node instanceof Element && path.length < 5) {
        let segment = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (siblings.length > 1) {
            segment += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
          }
        }
        path.unshift(segment);
        node = parent;
      }
      return path.join(' > ');
    };

    const interactiveElements = Array.from(document.querySelectorAll('a, button, input, textarea, select, [role="button"], [onclick]'))
      .slice(0, 24)
      .map((element) => ({
        selector: buildSelector(element),
        tag: element.tagName.toLowerCase(),
        text: normalizeText(element.textContent || element.getAttribute('value') || element.getAttribute('placeholder')).slice(0, 120),
        role: element.getAttribute('role'),
      }))
      .filter((entry) => Boolean(entry.selector));

    return {
      url: location.href,
      title: document.title,
      origin: location.origin || null,
      textPreview: normalizeText(document.body?.innerText || '').slice(0, 1600),
      interactiveElements,
      capturedAt: Date.now(),
    };
  `);
}

async function runAutomationAction(action: BrowserAutomationAction): Promise<BrowserAutomationActionResult> {
  return await executeInPage<BrowserAutomationActionResult>(`
    const ensureElement = (selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error('Element not found for selector: ' + selector);
      }
      return element;
    };

    switch (payload?.type) {
      case 'click': {
        const element = ensureElement(payload.selector);
        element.scrollIntoView({ block: 'center', inline: 'center' });
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { ok: true, type: payload.type, selector: payload.selector };
      }

      case 'input': {
        const element = ensureElement(payload.selector);
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
          throw new Error('Selected element does not accept text input: ' + payload.selector);
        }
        element.focus();
        if ('value' in element) {
          element.value = payload.text;
        }
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: payload.text }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, type: payload.type, selector: payload.selector, textLength: payload.text.length };
      }

      case 'scroll': {
        window.scrollTo({ top: payload.top || 0, left: payload.left || 0, behavior: 'auto' });
        return { ok: true, type: payload.type, top: window.scrollY, left: window.scrollX };
      }

      case 'wait': {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({ ok: true, type: payload.type, timeoutMs: payload.timeoutMs });
          }, Math.max(0, Number(payload.timeoutMs) || 0));
        });
      }

      default:
        throw new Error('Unsupported browser automation action.');
    }
  `, action);
}

defineExpose({
  captureAutomationSnapshot,
  runAutomationAction,
});

function emitStateChange() {
  emit("stateChange", {
    appId: props.appId,
    url: currentUrl.value,
    title: currentTitle.value,
    icon: currentIcon.value,
  });
}

function emitShellContextMenu(event: MouseEvent) {
  console.info("[browser-webview] shell-contextmenu", {
    appId: props.appId,
    x: event.clientX,
    y: event.clientY,
    url: currentUrl.value,
    title: currentTitle.value,
  });
  emit("contextMenu", {
    appId: props.appId,
    x: event.clientX,
    y: event.clientY,
  });
}

function syncFromWebview() {
  const webview = webviewRef.value;
  if (!webview) return;

  try {
    const nextUrl = webview.getURL();
    if (nextUrl) currentUrl.value = nextUrl;
  } catch {
    // Ignore transient URL access failures while the webview is navigating.
  }

  emitStateChange();
}

function attachWebviewListeners() {
  const webview = webviewRef.value;
  if (!webview) return () => {};

  const handleTitleUpdated = (event: Event) => {
    const payload = event as Event & { title?: string };
    currentTitle.value =
      payload.title?.trim() || currentTitle.value || currentUrl.value;
    emitStateChange();
  };

  const handleFaviconUpdated = (event: Event) => {
    const payload = event as Event & { favicons?: string[] };
    currentIcon.value = payload.favicons?.[0] || currentIcon.value;
    emitStateChange();
  };

  const handleNavigation = () => {
    syncFromWebview();
  };

  const handleDidFinishLoad = () => {
    console.info("[browser-webview] did-finish-load", {
      appId: props.appId,
      url: currentUrl.value,
      title: currentTitle.value,
    });
    syncFromWebview();
  };

  const handleDidFailLoad = (event: Event) => {
    const payload = event as Event & {
      errorCode?: number;
      errorDescription?: string;
      validatedURL?: string;
      isMainFrame?: boolean;
    };

    console.warn("[browser-webview] did-fail-load", {
      appId: props.appId,
      url: payload.validatedURL || currentUrl.value,
      errorCode: payload.errorCode,
      errorDescription: payload.errorDescription,
      isMainFrame: payload.isMainFrame,
    });
  };

  const handleContextMenu = (event: Event) => {
    const payload = event as Event & { params?: { x?: number; y?: number } };
    console.info("[browser-webview] guest-contextmenu", {
      appId: props.appId,
      x: payload.params?.x ?? 0,
      y: payload.params?.y ?? 0,
      url: currentUrl.value,
      title: currentTitle.value,
    });
    emit("contextMenu", {
      appId: props.appId,
      x: payload.params?.x ?? 0,
      y: payload.params?.y ?? 0,
    });
  };

  webview.addEventListener(
    "page-title-updated",
    handleTitleUpdated as EventListener,
  );
  webview.addEventListener(
    "page-favicon-updated",
    handleFaviconUpdated as EventListener,
  );
  webview.addEventListener("did-navigate", handleNavigation as EventListener);
  webview.addEventListener(
    "did-navigate-in-page",
    handleNavigation as EventListener,
  );
  webview.addEventListener(
    "did-stop-loading",
    handleNavigation as EventListener,
  );
  webview.addEventListener(
    "did-finish-load",
    handleDidFinishLoad as EventListener,
  );
  webview.addEventListener("did-fail-load", handleDidFailLoad as EventListener);
  webview.addEventListener("context-menu", handleContextMenu as EventListener);

  return () => {
    webview.removeEventListener(
      "page-title-updated",
      handleTitleUpdated as EventListener,
    );
    webview.removeEventListener(
      "page-favicon-updated",
      handleFaviconUpdated as EventListener,
    );
    webview.removeEventListener(
      "did-navigate",
      handleNavigation as EventListener,
    );
    webview.removeEventListener(
      "did-navigate-in-page",
      handleNavigation as EventListener,
    );
    webview.removeEventListener(
      "did-stop-loading",
      handleNavigation as EventListener,
    );
    webview.removeEventListener(
      "did-finish-load",
      handleDidFinishLoad as EventListener,
    );
    webview.removeEventListener(
      "did-fail-load",
      handleDidFailLoad as EventListener,
    );
    webview.removeEventListener(
      "context-menu",
      handleContextMenu as EventListener,
    );
  };
}

let detachListeners: (() => void) | null = null;

watch(
  () => props.url,
  async (nextUrl) => {
    currentUrl.value = nextUrl;
    await nextTick();
    const webview = webviewRef.value;
    if (!webview) return;
    try {
      const activeUrl = webview.getURL();
      if (activeUrl !== nextUrl) {
        if (typeof webview.loadURL === "function") {
          webview.loadURL(nextUrl);
        } else {
          webview.src = nextUrl;
        }
      }
    } catch {
      webview.src = nextUrl;
    }
  },
  { flush: "post" },
);

watch(
  () => props.title,
  (nextTitle) => {
    if (nextTitle.trim()) currentTitle.value = nextTitle;
  },
);

watch(
  () => props.icon,
  (nextIcon) => {
    currentIcon.value = nextIcon;
  },
);

onMounted(async () => {
  await nextTick();
  detachListeners = attachWebviewListeners();
  emitStateChange();
});

onUnmounted(() => {
  detachListeners?.();
});
</script>

<template>
  <div
    class="browser-view-shell"
    @contextmenu.prevent="emitShellContextMenu($event)"
  >
    <div
      class="browser-view-bar"
      @contextmenu.prevent="emitShellContextMenu($event)"
    >
      <span class="browser-view-icon-wrap">
        <img
          v-if="resolvedIcon.kind === 'image'"
          :src="resolvedIcon.value"
          alt=""
          class="browser-view-icon-img"
        />
        <span v-else class="browser-view-icon-text">{{
          resolvedIcon.value
        }}</span>
      </span>
      <div class="browser-view-meta">
        <span class="browser-view-title">{{ currentTitle }}</span>
        <span class="browser-view-url">{{ currentUrl }}</span>
      </div>
    </div>
    <webview
      ref="webviewRef"
      class="browser-view-webview"
      :src="props.url"
      partition="persist:the-world-browser"
      allowpopups
    ></webview>
  </div>
</template>

<style scoped>
.browser-view-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: #fff;
}

.browser-view-bar {
  height: 46px;
  padding: 0 14px;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  border-bottom: 1px solid rgba(15, 23, 42, 0.08);
  background: linear-gradient(
    180deg,
    rgba(248, 250, 252, 0.98),
    rgba(241, 245, 249, 0.98)
  );
}

.browser-view-icon-wrap {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.9);
  overflow: hidden;
  flex-shrink: 0;
}

.browser-view-icon-img {
  width: 18px;
  height: 18px;
  object-fit: contain;
}

.browser-view-icon-text {
  font-size: 1rem;
  line-height: 1;
}

.browser-view-meta {
  min-width: 0;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
}

.browser-view-title,
.browser-view-url {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browser-view-title {
  color: #0f172a;
  font-size: 0.88rem;
  font-weight: 600;
}

.browser-view-url {
  color: #475569;
  font-size: 0.75rem;
}

.browser-view-webview {
  flex: 1;
  width: 100%;
  border: none;
}
</style>
