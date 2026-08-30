<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { resolveProjectIcon } from "../../utils/project-icon";
import { normalizeWebUrlInput } from "../../utils/web-app";
import type {
  BrowserAutomationAction,
  BrowserAutomationActionResult,
  BrowserAutomationSnapshot,
  BrowserAutomationSnapshotElement,
  BrowserAutomationSnapshotFormField,
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

const { t } = useI18n();
const webviewRef = ref<WebviewLikeElement | null>(null);
const addressInputRef = ref<HTMLInputElement | null>(null);
const currentUrl = ref(props.url);
const currentTitle = ref(props.title);
const currentIcon = ref(props.icon);
const addressInput = ref(props.url);
const isAddressInputFocused = ref(false);
const addressContextMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  copied: false,
});
let addressContextMenuResetTimer: number | null = null;

const resolvedIcon = computed(() =>
  resolveProjectIcon("browser", currentIcon.value),
);

const ADDRESS_CONTEXT_MENU_WIDTH = 128;
const ADDRESS_CONTEXT_MENU_HEIGHT = 112;

function syncAddressInput(nextUrl = currentUrl.value) {
  if (!isAddressInputFocused.value) {
    addressInput.value = nextUrl;
  }
}

function loadUrlInWebview(nextUrl: string) {
  const webview = webviewRef.value;
  if (!webview) return;

  try {
    if (typeof webview.loadURL === "function") {
      webview.loadURL(nextUrl);
    } else {
      webview.src = nextUrl;
    }
  } catch {
    webview.src = nextUrl;
  }
}

function submitAddress(event?: Event) {
  const normalizedUrl = normalizeWebUrlInput(addressInput.value);
  if (!normalizedUrl) {
    addressInput.value = currentUrl.value;
    return;
  }

  currentUrl.value = normalizedUrl;
  addressInput.value = normalizedUrl;
  emitStateChange();
  loadUrlInWebview(normalizedUrl);
  const form = event?.target as HTMLFormElement | null;
  form?.querySelector<HTMLInputElement>(".browser-view-url-input")?.blur();
}

function handleAddressFocus(event: FocusEvent) {
  isAddressInputFocused.value = true;
  const input = event.target as HTMLInputElement | null;
  requestAnimationFrame(() => input?.select());
}

function handleAddressBlur() {
  isAddressInputFocused.value = false;
  addressInput.value = currentUrl.value;
}

function cancelAddressEdit(event: KeyboardEvent) {
  addressInput.value = currentUrl.value;
  (event.target as HTMLInputElement | null)?.blur();
}

function hideAddressContextMenu() {
  addressContextMenu.visible = false;
  addressContextMenu.copied = false;
  if (addressContextMenuResetTimer != null) {
    window.clearTimeout(addressContextMenuResetTimer);
    addressContextMenuResetTimer = null;
  }
}

function openAddressContextMenu(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  isAddressInputFocused.value = true;
  addressInputRef.value?.focus({ preventScroll: true });
  addressContextMenu.visible = true;
  addressContextMenu.copied = false;
  addressContextMenu.x = Math.max(
    8,
    Math.min(event.clientX, window.innerWidth - ADDRESS_CONTEXT_MENU_WIDTH - 8),
  );
  addressContextMenu.y = Math.max(
    8,
    Math.min(event.clientY, window.innerHeight - ADDRESS_CONTEXT_MENU_HEIGHT - 8),
  );
}

async function writeTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function getAddressCopyText(): string {
  const input = addressInputRef.value;
  if (!input) return addressInput.value;
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? start;
  return start !== end ? input.value.slice(start, end) : input.value;
}

async function copyAddressInputText() {
  const text = getAddressCopyText();
  if (!text) return;

  await writeTextToClipboard(text);
  addressContextMenu.copied = true;
  if (addressContextMenuResetTimer != null) window.clearTimeout(addressContextMenuResetTimer);
  addressContextMenuResetTimer = window.setTimeout(() => {
    hideAddressContextMenu();
  }, 650);
}

function insertTextIntoAddressInput(text: string) {
  const input = addressInputRef.value;
  if (!input) return;

  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const nextValue = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
  const nextCaret = start + text.length;
  addressInput.value = nextValue;
  input.value = nextValue;
  input.focus({ preventScroll: true });
  window.requestAnimationFrame(() => {
    input.setSelectionRange(nextCaret, nextCaret);
  });
}

async function pasteAddressInputText() {
  const input = addressInputRef.value;
  if (!input) return;

  input.focus({ preventScroll: true });

  try {
    if (navigator.clipboard?.readText) {
      const text = await navigator.clipboard.readText();
      if (text) insertTextIntoAddressInput(text);
    } else {
      document.execCommand("paste");
    }
  } catch {
    document.execCommand("paste");
  } finally {
    hideAddressContextMenu();
  }
}

function selectAddressInputText() {
  const input = addressInputRef.value;
  if (!input) return;
  input.focus({ preventScroll: true });
  input.select();
  hideAddressContextMenu();
}

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

const SNAPSHOT_TEXT_PREVIEW_LIMIT = 12000;
const SNAPSHOT_INTERACTIVE_ELEMENT_LIMIT = 64;
const SNAPSHOT_FORM_FIELD_LIMIT = 64;
const SNAPSHOT_ELEMENT_TEXT_LIMIT = 240;

async function captureAutomationSnapshot(): Promise<BrowserAutomationSnapshot> {
  return await executeInPage<BrowserAutomationSnapshot>(`
    const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();

    const buildSelector = (element) => {
      if (!(element instanceof Element)) return null;
      if (element.id) return '#' + CSS.escape(element.id);

      const tokens = [
        ['data-testid', element.getAttribute('data-testid')],
        ['data-test', element.getAttribute('data-test')],
        ['data-id', element.getAttribute('data-id')],
        ['name', element.getAttribute('name')],
        ['aria-label', element.getAttribute('aria-label')],
        ['aria-labelledby', element.getAttribute('aria-labelledby')],
        ['placeholder', element.getAttribute('placeholder')],
        ['title', element.getAttribute('title')],
      ].filter((entry) => entry[1]);

      if (tokens.length > 0) {
        const [attribute, value] = tokens[0];
        return element.tagName.toLowerCase() + '[' + attribute + '="' + CSS.escape(value) + '"]';
      }

      const path = [];
      let node = element;
      while (node instanceof Element && path.length < 6) {
        let segment = node.tagName.toLowerCase();
        if (segment === 'html' || segment === 'body') {
          path.unshift(segment);
          break;
        }
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

    const findLabel = (element) => {
      const id = element.id;
      if (id) {
        const label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (label) return normalizeText(label.textContent);
      }
      let parent = element.parentElement;
      for (let i = 0; i < 3 && parent; i++) {
        if (parent.tagName.toLowerCase() === 'label') return normalizeText(parent.textContent);
        parent = parent.parentElement;
      }
      const ariaLabelledBy = element.getAttribute('aria-labelledby');
      if (ariaLabelledBy) {
        const labelEl = document.getElementById(ariaLabelledBy);
        if (labelEl) return normalizeText(labelEl.textContent);
      }
      return null;
    };

    const interactiveElements = Array.from(document.querySelectorAll(
      'a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [onclick]'
    ))
      .slice(0, ${SNAPSHOT_INTERACTIVE_ELEMENT_LIMIT})
      .map((element) => ({
        selector: buildSelector(element),
        tag: element.tagName.toLowerCase(),
        text: normalizeText(
          element.textContent || element.getAttribute('value') || element.getAttribute('placeholder') || element.getAttribute('aria-label')
        ).slice(0, ${SNAPSHOT_ELEMENT_TEXT_LIMIT}),
        role: element.getAttribute('role'),
      }))
      .filter((entry) => Boolean(entry.selector));

    const formFieldSelectors = 'input, textarea, select';
    const formFields = Array.from(document.querySelectorAll(formFieldSelectors))
      .slice(0, ${SNAPSHOT_FORM_FIELD_LIMIT})
      .map((element) => {
        const tag = element.tagName.toLowerCase();
        const type = element.getAttribute('type') || null;
        const field = {
          selector: buildSelector(element),
          tag,
          type,
          name: element.getAttribute('name') || null,
          label: findLabel(element),
          placeholder: element.getAttribute('placeholder') || null,
          value: '',
        };
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          field.value = element.value || '';
        } else if (element instanceof HTMLSelectElement) {
          field.value = element.value || '';
          field.options = Array.from(element.options).map((opt) => ({
            value: opt.value,
            label: normalizeText(opt.textContent || opt.value || ''),
          }));
        }
        return field;
      })
      .filter((entry) => Boolean(entry.selector));

    const rawText = normalizeText(document.body?.innerText || '');
    const textPreview = rawText.slice(0, ${SNAPSHOT_TEXT_PREVIEW_LIMIT});

    return {
      url: location.href,
      title: document.title,
      origin: location.origin || null,
      textPreview,
      fullTextAvailable: rawText.length <= ${SNAPSHOT_TEXT_PREVIEW_LIMIT},
      interactiveElements,
      formFields,
      capturedAt: Date.now(),
    };
  `);
}

async function runAutomationAction(action: BrowserAutomationAction): Promise<BrowserAutomationActionResult> {
  return await executeInPage<BrowserAutomationActionResult>(`
    const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

    const ensureElement = (selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error('Element not found for selector: ' + selector);
      }
      return element;
    };

    const setInputValue = (element, text, append) => {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        throw new Error('Selected element does not accept text input: ' + element.outerHTML.slice(0, 120));
      }
      element.focus();
      const nextValue = append ? (element.value + text) : text;
      element.value = nextValue;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return nextValue.length;
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
        const textLength = setInputValue(element, payload.text, Boolean(payload.append));
        return { ok: true, type: payload.type, selector: payload.selector, textLength };
      }

      case 'select': {
        const element = ensureElement(payload.selector);
        if (!(element instanceof HTMLSelectElement)) {
          throw new Error('Selected element is not a <select>: ' + payload.selector);
        }
        if (typeof payload.value === 'string') {
          element.value = payload.value;
        } else if (typeof payload.label === 'string') {
          const match = Array.from(element.options).find((opt) =>
            normalizeText(opt.textContent || '') === payload.label || opt.value === payload.label
          );
          if (!match) throw new Error('No option matched label: ' + payload.label);
          element.value = match.value;
        } else if (typeof payload.index === 'number') {
          if (payload.index < 0 || payload.index >= element.options.length) {
            throw new Error('Option index out of range: ' + payload.index);
          }
          element.value = element.options[payload.index].value;
        } else {
          throw new Error('select requires value, label, or index');
        }
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, type: payload.type, selector: payload.selector };
      }

      case 'batch_input': {
        if (!Array.isArray(payload.fields)) {
          throw new Error('batch_input requires a fields array');
        }
        let filled = 0;
        let skipped = 0;
        for (const field of payload.fields) {
          const element = document.querySelector(field?.selector);
          if (!element) {
            skipped++;
            continue;
          }
          try {
            if (element instanceof HTMLSelectElement) {
              element.value = field.text;
              element.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
              setInputValue(element, field.text, Boolean(field.append));
            } else {
              skipped++;
              continue;
            }
            filled++;
          } catch {
            skipped++;
          }
        }
        return { ok: true, type: payload.type, filled, skipped };
      }

      case 'extract': {
        let text = '';
        if (typeof payload.selector === 'string' && payload.selector.trim()) {
          const element = document.querySelector(payload.selector);
          if (!element) {
            throw new Error('Element not found for extract selector: ' + payload.selector);
          }
          text = normalizeText(element.innerText || '');
        } else {
          text = normalizeText(document.body?.innerText || '');
        }
        const offset = Math.max(0, Number(payload.offset) || 0);
        const maxChars = Number(payload.maxChars) || 0;
        const limit = maxChars > 0 ? maxChars : 60000;
        const slice = text.slice(offset, offset + limit);
        const truncated = offset + slice.length < text.length;
        return {
          ok: true,
          type: payload.type,
          selector: payload.selector,
          text: slice,
          offset,
          truncated,
          totalLength: text.length
        };
      }

      case 'evaluate': {
        if (typeof payload.script !== 'string' || !payload.script.trim()) {
          throw new Error('evaluate requires a non-empty script string');
        }
        // eslint-disable-next-line no-eval
        const result = eval(payload.script);
        return { ok: true, type: payload.type, result };
      }

      case 'hover': {
        const element = ensureElement(payload.selector);
        element.scrollIntoView({ block: 'center', inline: 'center' });
        element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        return { ok: true, type: payload.type, selector: payload.selector };
      }

      case 'focus': {
        const element = ensureElement(payload.selector);
        element.focus();
        return { ok: true, type: payload.type, selector: payload.selector };
      }

      case 'press_key': {
        const target = payload.selector ? ensureElement(payload.selector) : document.activeElement || document.body;
        target.focus();
        target.dispatchEvent(new KeyboardEvent('keydown', { key: payload.key, bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keypress', { key: payload.key, bubbles: true }));
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          if (payload.key.length === 1) {
            target.value += payload.key;
            target.dispatchEvent(new InputEvent('input', { data: payload.key, bubbles: true }));
          } else if (payload.key === 'Backspace') {
            target.value = target.value.slice(0, -1);
            target.dispatchEvent(new InputEvent('input', { bubbles: true }));
          }
        }
        target.dispatchEvent(new KeyboardEvent('keyup', { key: payload.key, bubbles: true }));
        return { ok: true, type: payload.type, selector: payload.selector, key: payload.key };
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
    if (nextUrl) {
      currentUrl.value = nextUrl;
      syncAddressInput(nextUrl);
    }
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
  };
}

let detachListeners: (() => void) | null = null;

watch(
  () => props.url,
  async (nextUrl) => {
    currentUrl.value = nextUrl;
    syncAddressInput(nextUrl);
    await nextTick();
    const webview = webviewRef.value;
    if (!webview) return;
    try {
      const activeUrl = webview.getURL();
      if (activeUrl !== nextUrl) {
        loadUrlInWebview(nextUrl);
      }
    } catch {
      loadUrlInWebview(nextUrl);
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
  document.addEventListener("click", hideAddressContextMenu);
  window.addEventListener("blur", hideAddressContextMenu);
  await nextTick();
  detachListeners = attachWebviewListeners();
  emitStateChange();
});

onUnmounted(() => {
  document.removeEventListener("click", hideAddressContextMenu);
  window.removeEventListener("blur", hideAddressContextMenu);
  hideAddressContextMenu();
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
        <form class="browser-view-address-form" @submit.prevent="submitAddress">
          <input
            ref="addressInputRef"
            v-model="addressInput"
            class="browser-view-url-input"
            type="text"
            spellcheck="false"
            autocomplete="off"
            autocapitalize="off"
            :title="addressInput"
            aria-label="URL"
            @focus="handleAddressFocus"
            @blur="handleAddressBlur"
            @keydown.esc.prevent="cancelAddressEdit"
            @contextmenu.prevent.stop="openAddressContextMenu"
          />
        </form>
      </div>
    </div>
    <webview
      ref="webviewRef"
      class="browser-view-webview"
      :src="props.url"
      partition="persist:the-world-browser"
      allowpopups
      @contextmenu.stop
    ></webview>
    <Teleport to="body">
      <div
        v-if="addressContextMenu.visible"
        class="browser-address-context-menu"
        :style="{ left: `${addressContextMenu.x}px`, top: `${addressContextMenu.y}px` }"
        @mousedown.prevent.stop
        @click.stop
        @contextmenu.prevent
      >
        <button class="browser-address-context-action" type="button" @click.stop="copyAddressInputText">
          {{ addressContextMenu.copied ? t('chatUi.copied') : t('common.copy') }}
        </button>
        <button class="browser-address-context-action" type="button" @click.stop="pasteAddressInputText">
          {{ t('common.paste') }}
        </button>
        <button class="browser-address-context-action" type="button" @click.stop="selectAddressInputText">
          {{ t('common.selectAll') }}
        </button>
      </div>
    </Teleport>
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
  flex: 1;
}

.browser-view-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browser-view-title {
  flex: 0 1 auto;
  max-width: 34%;
  color: #0f172a;
  font-size: 0.88rem;
  font-weight: 600;
}

.browser-view-address-form {
  min-width: 0;
  flex: 1 1 auto;
  margin: 0;
}

.browser-view-url-input {
  width: 100%;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  border: 1px solid rgba(148, 163, 184, 0.36);
  border-radius: 8px;
  outline: none;
  background: rgba(255, 255, 255, 0.92);
  color: #475569;
  font-size: 0.78rem;
  line-height: 30px;
}

.browser-view-url-input:focus {
  border-color: rgba(37, 99, 235, 0.55);
  background: #fff;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}

.browser-address-context-menu {
  position: fixed;
  z-index: 5000;
  min-width: 120px;
  padding: 4px;
  border: 1px solid rgba(148, 163, 184, 0.32);
  border-radius: 10px;
  background: #ffffff;
  box-shadow: 0 14px 36px rgba(15, 23, 42, 0.18);
}

.browser-address-context-action {
  width: 100%;
  height: 32px;
  padding: 0 12px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: #0f172a;
  font-size: 0.84rem;
  cursor: pointer;
  text-align: left;
}

.browser-address-context-action:hover {
  background: rgba(241, 245, 249, 0.95);
}

.browser-view-webview {
  flex: 1;
  width: 100%;
  border: none;
}
</style>
