<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { resolveProjectIcon } from "../../utils/project-icon";

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
