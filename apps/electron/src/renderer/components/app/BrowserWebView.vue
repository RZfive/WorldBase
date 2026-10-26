<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { resolveProjectIcon } from "../../utils/project-icon";
import { normalizeWebUrlInput } from "../../utils/web-app";
import type {
  BrowserAutomationAction,
  BrowserAutomationArticle,
  BrowserAutomationActionResult,
  BrowserAutomationConsoleEntry,
  BrowserAutomationDiagnostics,
  BrowserAutomationEmulateAction,
  BrowserAutomationNetworkEntry,
  BrowserAutomationPageError,
  BrowserAutomationScreenshot,
  BrowserAutomationSearchResults,
  BrowserAutomationSnapshot,
  BrowserAutomationSnapshotElement,
  BrowserAutomationSnapshotFormField,
  BrowserPageContextMenuPayload,
} from "../../../shared/page-automation-types.js";
import { findSearchExtractPreset } from "../../../shared/search-extract-presets.js";

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

interface BrowserContextElementInfo {
  selector: string;
  tag: string;
  text: string;
}

export interface BrowserContextAddPayload {
  kind: "selection" | "element";
  url: string;
  title: string;
  text: string;
  selector?: string;
  tag?: string;
}

interface PageContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  hasSelection: boolean;
  hasElement: boolean;
  hasLink: boolean;
  copied: boolean;
}

interface NativeImageLike {
  toDataURL: () => string;
  getSize: () => { width: number; height: number };
  resize?: (options: { width?: number; height?: number; quality?: "good" | "better" | "best" }) => NativeImageLike;
}

interface WebviewLikeElement extends HTMLElement {
  src: string;
  getURL: () => string;
  loadURL?: (url: string) => Promise<void> | void;
  reload?: () => void;
  reloadIgnoringCache?: () => void;
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  goBack?: () => void;
  goForward?: () => void;
  isLoading?: () => boolean;
  getZoomFactor?: () => number;
  getWebContentsId?: () => number;
  capturePage?: () => Promise<NativeImageLike>;
  sendInputEvent?: (event: Record<string, unknown>) => Promise<void> | void;
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
  (e: "contextAdd", payload: BrowserContextAddPayload): void;
  (e: "aiOperateRequest"): void;
}>();

const { t } = useI18n();
const webviewRef = ref<WebviewLikeElement | null>(null);
const addressInputRef = ref<HTMLInputElement | null>(null);
const currentUrl = ref(props.url);
const currentTitle = ref(props.title);
const currentIcon = ref(props.icon);
const addressInput = ref(props.url);
/** Optional AI device viewport; rendered as the webview's CSS box. */
const agentViewport = ref<{ width: number; height: number } | null>(null);

const MAX_DIAGNOSTICS_ENTRIES = 120;
const consoleBuffer: BrowserAutomationConsoleEntry[] = [];
const pageErrorBuffer: BrowserAutomationPageError[] = [];
let diagnosticsNavigationId = 0;
let diagnosticsHookInstall: { key: string; promise: Promise<void> } | null = null;
const isAddressInputFocused = ref(false);
const addressContextMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  copied: false,
});
let addressContextMenuResetTimer: number | null = null;

const pageContextMenu = reactive<PageContextMenuState>({
  visible: false,
  x: 0,
  y: 0,
  hasSelection: false,
  hasElement: false,
  hasLink: false,
  copied: false,
});
/** Snapshot of the page content under the most recent right-click. */
let pageContextSnapshot: {
  selectionText: string;
  element: BrowserContextElementInfo | null;
  linkURL: string;
} | null = null;
let pageContextMenuResetTimer: number | null = null;
let browserPageContextMenuCleanup: (() => void) | null = null;

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

  const serializedPayload = JSON.stringify(payload ?? null)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  return await webview.executeJavaScript<T>(
    `(async () => {
      const payload = ${serializedPayload};
      ${runner}
    })()`,
    true,
  );
}

const SNAPSHOT_TEXT_PREVIEW_LIMIT = 12000;
const SNAPSHOT_INTERACTIVE_ELEMENT_LIMIT = 96;
const SNAPSHOT_FORM_FIELD_LIMIT = 64;
const SNAPSHOT_ELEMENT_TEXT_LIMIT = 240;
const PAGE_CONTEXT_TEXT_LIMIT = 20000;

const PAGE_SERIALIZE_RESULT_SCRIPT = `
const serializeResult = (value) => {
  if (value === undefined) return { result: null, resultType: 'undefined' };
  if (value === null) return { result: null, resultType: 'null' };
  if (typeof value === 'function') return { result: String(value).slice(0, 8000), resultType: 'function' };
  if (typeof value === 'symbol' || typeof value === 'bigint') return { result: String(value), resultType: typeof value };
  if (value instanceof Element) return { result: value.outerHTML.slice(0, 8000), resultType: 'element' };
  if (value instanceof Node) return { result: String(value.textContent || '').slice(0, 8000), resultType: 'node' };
  if (value instanceof Error) {
    return {
      result: { name: value.name, message: value.message, stack: String(value.stack || '').slice(0, 8000) },
      resultType: 'error',
    };
  }
  if (value instanceof Date) return { result: value.toISOString(), resultType: 'date' };
  let normalized = value;
  if (value instanceof Map) normalized = Array.from(value.entries());
  else if (value instanceof Set) normalized = Array.from(value.values());
  if (typeof normalized !== 'object') return { result: normalized, resultType: typeof normalized };
  const seen = new WeakSet();
  try {
    const json = JSON.stringify(normalized, (key, item) => {
      if (typeof item === 'bigint') return String(item) + 'n';
      if (typeof item === 'function') return '[Function ' + (item.name || 'anonymous') + ']';
      if (typeof item === 'symbol') return String(item);
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    });
    if (json === undefined) return { result: null, resultType: 'undefined' };
    if (json.length <= 20000) {
      return { result: JSON.parse(json), resultType: Array.isArray(normalized) ? 'array' : 'object' };
    }
    return { result: json.slice(0, 20000), resultType: 'json-truncated' };
  } catch {
    try { return { result: String(normalized).slice(0, 8000), resultType: 'string' }; }
    catch { return { result: '[unserializable value]', resultType: 'unknown' }; }
  }
};
  `;

/** In-page helpers shared by the snapshot and context-menu capture runners. */
const PAGE_SCRIPT_HELPERS = `
    const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();

    const normalizeReadableText = (value) => String(value || '')
      .replace(/\\r\\n?/g, '\\n')
      .replace(/[ \\t]+/g, ' ')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();

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

    const refFor = (element) => {
      if (!(element instanceof Element)) return null;
      let ref = element.getAttribute('data-worldbase-ref');
      if (ref) return ref;
      const next = Number(window.__worldbaseRefSeq || 0) + 1;
      window.__worldbaseRefSeq = Number.isFinite(next) && next > 0 ? next : 1;
      ref = 'e' + window.__worldbaseRefSeq;
      element.setAttribute('data-worldbase-ref', ref);
      return ref;
    };

    const resolveTarget = (target) => {
      if (target && target.ref) {
        const byRef = document.querySelector('[data-worldbase-ref="' + CSS.escape(String(target.ref)) + '"]');
        if (byRef) return byRef;
        throw new Error('Element not found for ref: ' + target.ref + '. The page may have re-rendered; take a new snapshot.');
      }
      if (target && target.selector) {
        const bySelector = document.querySelector(target.selector);
        if (bySelector) return bySelector;
        throw new Error('Element not found for selector: ' + target.selector);
      }
      throw new Error('A selector or ref is required for this action');
    };

    const accessibleName = (element) => {
      const ariaLabel = normalizeText(element.getAttribute('aria-label'));
      if (ariaLabel) return ariaLabel;
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy.split(/\\s+/)
          .map((id) => document.getElementById(id)?.textContent || '')
          .join(' ');
        if (normalizeText(text)) return normalizeText(text);
      }
      if (element.id) {
        const label = document.querySelector('label[for="' + CSS.escape(element.id) + '"]');
        if (label) return normalizeText(label.textContent);
      }
      if (element.getAttribute('placeholder')) return normalizeText(element.getAttribute('placeholder'));
      if (element.getAttribute('title')) return normalizeText(element.getAttribute('title'));
      if (element instanceof HTMLSelectElement && element.selectedOptions && element.selectedOptions[0]) {
        return normalizeText(element.selectedOptions[0].textContent || element.selectedOptions[0].value || '');
      }
      if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes((element.type || '').toLowerCase())) {
        if (element.value) return normalizeText(element.value);
      }
      if (element instanceof HTMLImageElement && element.alt) return normalizeText(element.alt);
      return normalizeText(element.textContent || element.getAttribute('value') || '');
    };

    const inferredRole = (element) => {
      const explicit = element.getAttribute('role');
      if (explicit) return explicit;
      if (element.isContentEditable) return 'textbox';
      const tag = element.tagName.toLowerCase();
      if (tag === 'a' || tag === 'area') return element.hasAttribute('href') ? 'link' : null;
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'option') return 'option';
      if (tag === 'input') {
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
        if (type === 'search') return 'searchbox';
        if (type === 'number') return 'spinbutton';
        if (type === 'range') return 'slider';
        if (type === 'file') return 'button';
        return 'textbox';
      }
      return null;
    };

    const isElementVisible = (element) => {
      if (typeof element.checkVisibility === 'function') {
        try {
          if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        } catch {
          // Older Chromium builds only accept the no-argument form.
        }
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0;
    };

    const elementBounds = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x * 100) / 100,
        y: Math.round(rect.y * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
      };
    };

    const elementHref = (element) => {
      if (element instanceof HTMLAnchorElement || element instanceof HTMLAreaElement) {
        return element.href || null;
      }
      const href = element.getAttribute('href');
      return href ? String(href) : null;
    };

    ${PAGE_SERIALIZE_RESULT_SCRIPT}
  `;

async function captureAutomationSnapshot(): Promise<BrowserAutomationSnapshot> {
  return await executeInPage<BrowserAutomationSnapshot>(`
    ${PAGE_SCRIPT_HELPERS}

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
      'a[href], area[href], button, input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="option"], [role="textbox"], [role="searchbox"], [role="slider"], [role="spinbutton"], [role="treeitem"], [contenteditable]:not([contenteditable="false"]), [onclick]'
    ))
      .slice(0, ${SNAPSHOT_INTERACTIVE_ELEMENT_LIMIT})
      .map((element) => {
        const tag = element.tagName.toLowerCase();
        const type = element instanceof HTMLInputElement
          ? (element.getAttribute('type') || 'text')
          : element instanceof HTMLButtonElement
            ? (element.getAttribute('type') || 'button')
            : element.isContentEditable
              ? 'contenteditable'
              : null;
        const ariaChecked = element.getAttribute('aria-checked');
        return {
          ref: refFor(element),
          selector: buildSelector(element),
          tag,
          text: normalizeText(
            element.textContent || element.getAttribute('value') || element.getAttribute('placeholder') || element.getAttribute('aria-label')
          ).slice(0, ${SNAPSHOT_ELEMENT_TEXT_LIMIT}),
          role: inferredRole(element),
          name: accessibleName(element).slice(0, ${SNAPSHOT_ELEMENT_TEXT_LIMIT}),
          type,
          value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
            ? String(element.value || '').slice(0, 2000)
            : element.isContentEditable
              ? normalizeText(element.innerText || element.textContent || '').slice(0, 2000)
              : null,
          href: elementHref(element),
          placeholder: element.getAttribute('placeholder') || null,
          title: element.getAttribute('title') || null,
          checked: element instanceof HTMLInputElement && (type === 'checkbox' || type === 'radio')
            ? Boolean(element.checked)
            : ariaChecked === 'true'
              ? true
              : ariaChecked === 'false'
                ? false
                : null,
          disabled: 'disabled' in element ? Boolean(element.disabled) : element.getAttribute('aria-disabled') === 'true',
          visible: isElementVisible(element),
          bounds: elementBounds(element),
        };
      })
      .filter((entry) => Boolean(entry.selector));

    const formFieldSelectors = 'input:not([type="hidden"]), textarea, select, [contenteditable]:not([contenteditable="false"])';
    const formFields = Array.from(document.querySelectorAll(formFieldSelectors))
      .slice(0, ${SNAPSHOT_FORM_FIELD_LIMIT})
      .map((element) => {
        const tag = element.tagName.toLowerCase();
        const type = element.getAttribute('type') || (tag === 'select' ? 'select' : element.isContentEditable ? 'contenteditable' : null);
        const field = {
          ref: refFor(element),
          selector: buildSelector(element),
          tag,
          type,
          name: element.getAttribute('name') || null,
          label: findLabel(element) || accessibleName(element),
          placeholder: element.getAttribute('placeholder') || null,
          value: '',
        };
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          field.value = String(element.value || '').slice(0, 2000);
        } else if (element instanceof HTMLSelectElement) {
          field.value = String(element.value || '').slice(0, 2000);
          field.options = Array.from(element.options).slice(0, 200).map((opt) => ({
            value: opt.value,
            label: normalizeText(opt.textContent || opt.value || ''),
          }));
        } else {
          field.value = normalizeText(element.innerText || element.textContent || '').slice(0, 2000);
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

const ARTICLE_TEXT_LIMIT = 24000;
/** Non-content chrome excluded from reading-mode extraction. */
const ARTICLE_SKIP_TAGS = 'nav, header, footer, aside, script, style, noscript, form, template, iframe, svg, button, select, input, textarea';

/**
 * Reading-mode extraction: pick the densest content container and serialize
 * its headings/paragraphs/lists as markdown-ish text. Skips navigation,
 * headers/footers, asides, and forms so retrieval gets the article, not the
 * page chrome.
 */
async function captureArticleSnapshot(): Promise<BrowserAutomationArticle> {
  return await executeInPage<BrowserAutomationArticle>(`
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();

    const containerScore = (element) => {
      const copy = element.cloneNode(true);
      copy.querySelectorAll('${ARTICLE_SKIP_TAGS}').forEach((node) => node.remove());
      let score = 0;
      copy.querySelectorAll('p, li, blockquote, article, section, td, th, pre, h1, h2, h3, h4, h5, h6').forEach((node) => {
        score += normalize(node.textContent || '').length;
      });
      const linkLength = Array.from(copy.querySelectorAll('a')).reduce(
        (sum, anchor) => sum + normalize(anchor.textContent || '').length,
        0
      );
      const totalLength = Math.max(1, normalize(copy.textContent || '').length);
      return score * (1 - Math.min(0.9, linkLength / totalLength));
    };

    const textLengthOf = (element) => normalize(element.innerText || element.textContent || '').length;
    const bodyTextLength = document.body ? textLengthOf(document.body) : 0;
    let best = null;
    let bestScore = -1;
    const consider = (candidate, weight) => {
      const length = textLengthOf(candidate);
      if (length < 200) return;
      const score = containerScore(candidate) * weight;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    };

    const semanticMinimum = Math.min(400, Math.max(200, bodyTextLength * 0.15));
    for (const candidate of Array.from(document.querySelectorAll('article, main, [role="main"], .markdown-body, .entry-content, .post, .article'))) {
      if (textLengthOf(candidate) < semanticMinimum) continue;
      consider(candidate, 1 + Math.min(0.5, textLengthOf(candidate) / Math.max(1, bodyTextLength)));
    }
    if (!best) {
      for (const candidate of Array.from(document.querySelectorAll('article, main, [role="main"], .markdown-body, .entry-content, .post, .article, #content, .content, .post-content, .article-content, [itemprop="articleBody"]'))) {
        consider(candidate, 1);
      }
    }
    if (!best) best = document.body || document.documentElement;

    if (!best) {
      return {
        url: location.href,
        title: document.title,
        origin: location.origin || null,
        text: '',
        wordCount: 0,
        truncated: false,
        capturedAt: Date.now(),
      };
    }

    const blockTags = new Set([
      'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption',
      'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main',
      'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul'
    ]);
    const isBlockElement = (element) => {
      if (blockTags.has(element.tagName.toLowerCase())) return true;
      const display = getComputedStyle(element).display;
      return display === 'block' || display === 'list-item' || display === 'flex' || display === 'grid'
        || display === 'table' || display.startsWith('table-');
    };
    const hasBlockChild = (element) => Array.from(element.children).some(isBlockElement);

    const LIMIT = ${ARTICLE_TEXT_LIMIT};
    const lines = [];
    let totalChars = 0;
    let overflow = false;
    const pushLine = (line) => {
      if (!line) return;
      if (totalChars >= LIMIT) {
        overflow = true;
        return;
      }
      lines.push(line);
      totalChars += line.length + 2;
    };

    const pushBlock = (element) => {
      if (element.closest('${ARTICLE_SKIP_TAGS}')) return;
      const tag = element.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const level = Number(tag[1]);
        pushLine('#'.repeat(level) + ' ' + normalize(element.textContent));
        return;
      }
      if (tag === 'li') {
        pushLine('- ' + normalize(element.textContent));
        return;
      }
      if (tag === 'pre') {
        const text = (element.textContent || '').replace(/\\n+$/, '');
        if (text.trim()) pushLine('\\n\`\`\`\\n' + text + '\\n\`\`\`\\n');
        return;
      }
      if (tag === 'br') return;
      if (['p', 'blockquote', 'dd', 'dt', 'figcaption', 'td', 'th'].includes(tag)) {
        pushLine(normalize(element.textContent));
        return;
      }
      if (!hasBlockChild(element)) {
        const text = normalize(element.innerText || element.textContent || '');
        if (text) pushLine(text);
        return;
      }
      const directText = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => normalize(node.textContent || ''))
        .filter(Boolean)
        .join(' ');
      if (directText) pushLine(directText);
      for (const child of element.children) {
        pushBlock(child);
        if (totalChars >= LIMIT) {
          overflow = true;
          break;
        }
      }
    };

    for (const child of best.children) {
      pushBlock(child);
      if (totalChars >= LIMIT) {
        overflow = true;
        break;
      }
    }

    let text = lines.join('\\n\\n');
    if (!text && document.body) {
      text = String(document.body.innerText || document.body.textContent || '')
        .replace(/\\r\\n?/g, '\\n')
        .replace(/[ \\t]+/g, ' ')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();
    }
    const truncated = overflow || text.length > LIMIT;
    if (text.length > LIMIT) text = text.slice(0, LIMIT);

    return {
      url: location.href,
      title: document.title,
      origin: location.origin || null,
      text,
      wordCount: text ? text.split(/\\s+/).filter(Boolean).length : 0,
      truncated,
      capturedAt: Date.now(),
    };
  `);
}

async function captureSearchResults(): Promise<BrowserAutomationSearchResults> {
  const webview = webviewRef.value;
  const pageUrl = (webview ? readWebviewUrl(webview) : undefined) || currentUrl.value;
  const preset = findSearchExtractPreset(pageUrl);
  return await executeInPage<BrowserAutomationSearchResults>(`
    ${PAGE_SCRIPT_HELPERS}

    const preset = payload.preset;
    const limit = Math.max(1, Math.min(Number(payload.limit) || 30, 60));
    const results = [];
    const seen = new Set();
    const isGoogleHost = (host) => /(^|\\.)google\\.[a-z]{2,3}(\\.[a-z]{2})?$/.test(host);

    const unwrapResultUrl = (raw) => {
      let parsed;
      try {
        parsed = new URL(String(raw || ''), location.href);
      } catch {
        return '';
      }
      if (isGoogleHost(parsed.hostname.toLowerCase()) && parsed.pathname === '/url') {
        const target = parsed.searchParams.get('q') || parsed.searchParams.get('url');
        if (target) {
          try { return new URL(target, location.href).href; } catch { /* keep the redirect URL */ }
        }
      }
      if (parsed.hostname.toLowerCase().endsWith('duckduckgo.com') && parsed.pathname.startsWith('/l/')) {
        const target = parsed.searchParams.get('uddg');
        if (target) {
          try { return new URL(target, location.href).href; } catch { /* keep the redirect URL */ }
        }
      }
      if (parsed.hostname.toLowerCase().endsWith('bing.com') && parsed.pathname === '/ck/a') {
        const target = parsed.searchParams.get('u');
        if (target) {
          if (/^https?:/i.test(target)) return target;
          if (target.startsWith('a1')) {
            try {
              const base64 = target.slice(2).replace(/-/g, '+').replace(/_/g, '/');
              const decoded = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
              if (/^https?:/i.test(decoded)) return decoded;
            } catch { /* keep the redirect URL */ }
          }
        }
      }
      return parsed.href;
    };

    const pushResult = (title, url, snippet) => {
      const cleanTitle = normalizeText(title);
      const cleanUrl = unwrapResultUrl(url);
      if (!cleanTitle || !cleanUrl || !/^https?:/i.test(cleanUrl)) return;
      const key = cleanUrl.replace(/#.*$/, '');
      if (seen.has(key)) return;
      seen.add(key);
      results.push({
        rank: results.length + 1,
        title: cleanTitle.slice(0, 240),
        url: cleanUrl,
        snippet: normalizeText(snippet).slice(0, 400),
      });
    };

    const pickLinkNode = (container, titleNode) => {
      if (titleNode) {
        if (titleNode instanceof HTMLAnchorElement && titleNode.href) return titleNode;
        const closest = titleNode.closest('a[href]');
        if (closest) return closest;
        const nested = titleNode.querySelector('a[href]');
        if (nested) return nested;
      }
      return preset.linkSelectors
        .map((candidate) => container.querySelector(candidate))
        .find(Boolean) || null;
    };

    if (preset) {
      for (const selector of preset.resultSelectors) {
        for (const container of Array.from(document.querySelectorAll(selector))) {
          const titleNode = preset.titleSelectors
            .map((candidate) => container.querySelector(candidate))
            .find(Boolean);
          const linkNode = pickLinkNode(container, titleNode);
          const snippetNode = preset.snippetSelectors
            .map((candidate) => container.querySelector(candidate))
            .find(Boolean);
          const title = titleNode
            ? normalizeText(titleNode.getAttribute('aria-label') || titleNode.textContent || '')
            : '';
          const url = linkNode instanceof HTMLAnchorElement
            ? (linkNode.href || linkNode.getAttribute('href') || '')
            : (linkNode?.getAttribute('href') || '');
          const snippet = snippetNode ? normalizeText(snippetNode.textContent || '') : '';
          pushResult(title, url, snippet);
          if (results.length >= limit) break;
        }
        if (results.length >= limit) break;
      }
    }

    if (results.length === 0) {
      const anchors = Array.from(document.querySelectorAll('a[href]'))
        .filter((anchor) => {
          if (anchor.closest('nav, header, footer, aside, form')) return false;
          const href = String(anchor.href || '');
          if (!/^https?:/i.test(href) || href.startsWith(location.origin + '/search')) return false;
          const heading = anchor.querySelector('h1, h2, h3, h4');
          return Boolean(heading) || normalizeText(anchor.textContent || '').length >= 24;
        });
      for (const anchor of anchors) {
        const heading = anchor.querySelector('h1, h2, h3, h4');
        const container = anchor.closest('li, article, section, div') || anchor.parentElement;
        const text = normalizeText(anchor.textContent || '');
        const containerText = container && container !== anchor ? normalizeText(container.textContent || '') : '';
        const snippet = containerText && containerText !== text
          ? (containerText.startsWith(text) ? containerText.slice(text.length) : containerText).trim().slice(0, 400)
          : '';
        pushResult(heading ? heading.textContent || '' : text, anchor.href, snippet);
        if (results.length >= limit) break;
      }
    }

    return {
      url: location.href,
      title: document.title,
      origin: location.origin || null,
      results,
      capturedAt: Date.now(),
    };
  `, { preset, limit: 30 });
}

/**
 * Installs read-only diagnostics hooks in the current page context. The
 * browser's own events capture console output; this captures uncaught errors
 * and fetch/XHR traffic that never reaches the console.
 */
function diagnosticsDocumentKey(): string {
  const webview = webviewRef.value;
  const url = webview ? readWebviewUrl(webview) : undefined;
  return `${diagnosticsNavigationId}:${url || currentUrl.value}`;
}

async function installDiagnosticsHooks(): Promise<void> {
  const webview = webviewRef.value;
  const executeJavaScript = webview?.executeJavaScript;
  if (!executeJavaScript) return;

  const key = diagnosticsDocumentKey();
  if (diagnosticsHookInstall?.key === key) {
    return await diagnosticsHookInstall.promise;
  }

  const promise = (async () => {
    try {
      await executeJavaScript(
        `(() => {
          const MAX = ${MAX_DIAGNOSTICS_ENTRIES};
          let state = window.__worldbaseDiagnostics;
          const legacyState = Boolean(state && typeof state.version !== 'number');
          if (state && state.installedVersion >= 2) return true;
          if (!state) {
            state = { version: 2, installedVersion: 0, errors: [], network: [], clearedAt: 0 };
            window.__worldbaseDiagnostics = state;
          } else {
            if (!Array.isArray(state.errors)) state.errors = [];
            if (!Array.isArray(state.network)) state.network = [];
            if (typeof state.clearedAt !== 'number') state.clearedAt = 0;
          }
          const push = (list, entry) => {
            list.push(entry);
            if (list.length > MAX) list.splice(0, list.length - MAX);
          };
          const recordNetwork = (entry) => push(state.network, entry);
          if (legacyState || state.listenersInstalled) {
            state.listenersInstalled = true;
          } else {
            state.listenersInstalled = true;
            window.addEventListener('error', (event) => {
              const target = event.target;
              const tag = target && target !== window && target.tagName ? String(target.tagName).toLowerCase() : '';
              if (tag === 'img' || tag === 'script' || tag === 'link' || tag === 'video' || tag === 'audio' || tag === 'source' || tag === 'iframe') {
                const source = String(target.currentSrc || target.src || target.href || '');
                push(state.errors, {
                  kind: 'load',
                  message: ('Resource failed to load: ' + tag + (source ? ' ' + source : '')).slice(0, 4000),
                  source: source ? source.slice(0, 2000) : null,
                  timestamp: Date.now(),
                });
                return;
              }
              push(state.errors, {
                kind: 'error',
                message: String(event.message || (event.error && event.error.message) || 'Unknown error').slice(0, 4000),
                source: event.filename ? String(event.filename).slice(0, 2000) : null,
                line: typeof event.lineno === 'number' ? event.lineno : null,
                column: typeof event.colno === 'number' ? event.colno : null,
                stack: event.error && event.error.stack ? String(event.error.stack).slice(0, 8000) : null,
                timestamp: Date.now(),
              });
            }, true);
            window.addEventListener('unhandledrejection', (event) => {
              const reason = event.reason;
              push(state.errors, {
                kind: 'unhandledrejection',
                message: String((reason && reason.message) || reason || 'Unhandled rejection').slice(0, 4000),
                stack: reason && reason.stack ? String(reason.stack).slice(0, 8000) : null,
                timestamp: Date.now(),
              });
            });
          }
          if (!legacyState && !state.fetchHooked && typeof window.fetch === 'function') {
            state.fetchHooked = true;
            const originalFetch = window.fetch;
            window.fetch = function (...args) {
              const startedAt = performance.now();
              const input = args[0];
              const url = typeof input === 'string' ? input : (input && input.url) || '';
              const method = String((args[1] && args[1].method) || (input && input.method) || 'GET');
              return originalFetch.apply(this, args).then((response) => {
                recordNetwork({
                  url: String(response.url || url),
                  method,
                  status: response.status,
                  ok: response.ok,
                  type: 'fetch',
                  durationMs: Math.round(performance.now() - startedAt),
                  transferSize: null,
                  error: null,
                  timestamp: Date.now(),
                });
                return response;
              }).catch((error) => {
                recordNetwork({
                  url: String(url),
                  method,
                  status: null,
                  ok: false,
                  type: 'fetch',
                  durationMs: Math.round(performance.now() - startedAt),
                  transferSize: null,
                  error: String(error),
                  timestamp: Date.now(),
                });
                throw error;
              });
            };
          } else if (legacyState) {
            state.fetchHooked = true;
          }
          if (!legacyState && !state.xhrHooked && window.XMLHttpRequest) {
            state.xhrHooked = true;
            const OriginalXHR = window.XMLHttpRequest;
            const originalOpen = OriginalXHR.prototype.open;
            const originalSend = OriginalXHR.prototype.send;
            OriginalXHR.prototype.open = function (method, url, ...rest) {
              this.__worldbaseRequest = { method: String(method || 'GET'), url: String(url || '') };
              return originalOpen.call(this, method, url, ...rest);
            };
            OriginalXHR.prototype.send = function (...args) {
              const startedAt = performance.now();
              this.addEventListener('loadend', () => {
                const request = this.__worldbaseRequest || { method: 'GET', url: '' };
                recordNetwork({
                  url: String(request.url),
                  method: String(request.method),
                  status: this.status || null,
                  ok: this.status >= 200 && this.status < 400,
                  type: 'xhr',
                  durationMs: Math.round(performance.now() - startedAt),
                  transferSize: null,
                  error: this.status === 0 ? (this.statusText || 'Request failed or was blocked') : null,
                  timestamp: Date.now(),
                });
              });
              return originalSend.apply(this, args);
            };
          } else if (legacyState) {
            state.xhrHooked = true;
          }
          state.version = 2;
          state.installedVersion = 2;
          return true;
        })()`,
        true,
      );
    } catch {
      // Diagnostics are best-effort: a page that blocks injection still has
      // console/load events from the webview itself.
    }
  })();

  const record = { key, promise };
  diagnosticsHookInstall = record;
  try {
    await promise;
  } finally {
    if (diagnosticsHookInstall === record) diagnosticsHookInstall = null;
  }
}

async function captureDiagnostics(options: { clear?: boolean } = {}): Promise<BrowserAutomationDiagnostics> {
  const webview = webviewRef.value;
  if (!webview) {
    throw new Error("Browser diagnostics are unavailable for this page surface.");
  }

  await installDiagnosticsHooks();

  let captured: {
    page: Omit<BrowserAutomationDiagnostics, "console" | "errors" | "network" | "canGoBack" | "canGoForward" | "capturedAt">;
    errors: BrowserAutomationPageError[];
    network: BrowserAutomationNetworkEntry[];
    resources: BrowserAutomationNetworkEntry[];
  } | null = null;
  let captureError: Error | null = null;

  try {
    captured = await executeInPage<{
      page: Omit<BrowserAutomationDiagnostics, "console" | "errors" | "network" | "canGoBack" | "canGoForward" | "capturedAt">;
      errors: BrowserAutomationPageError[];
      network: BrowserAutomationNetworkEntry[];
      resources: BrowserAutomationNetworkEntry[];
    }>(`
      ${PAGE_SCRIPT_HELPERS}

      const diagnostics = window.__worldbaseDiagnostics || { errors: [], network: [], clearedAt: 0 };
      const clearedAt = Number(diagnostics.clearedAt) || 0;
      const resources = (performance.getEntriesByType('resource') || [])
        .slice(-${MAX_DIAGNOSTICS_ENTRIES})
        .map((entry) => ({
          url: String(entry.name || ''),
          method: null,
          status: null,
          ok: null,
          type: String(entry.initiatorType || 'resource'),
          durationMs: Math.round(Number(entry.duration) || 0),
          transferSize: typeof entry.transferSize === 'number' ? entry.transferSize : null,
          error: null,
          timestamp: Math.round(performance.timeOrigin + (Number(entry.startTime) || 0)),
        }))
        .filter((entry) => entry.url && !entry.url.startsWith('data:') && !entry.url.startsWith('blob:') && entry.timestamp >= clearedAt);

      const documentElement = document.documentElement;
      const body = document.body;
      const result = {
        page: {
          url: location.href,
          title: document.title,
          origin: location.origin || null,
          readyState: document.readyState,
          visibilityState: document.visibilityState,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio || 1,
          },
          scroll: {
            x: Math.round(window.scrollX),
            y: Math.round(window.scrollY),
            width: Math.max(documentElement ? documentElement.scrollWidth : 0, body ? body.scrollWidth : 0),
            height: Math.max(documentElement ? documentElement.scrollHeight : 0, body ? body.scrollHeight : 0),
          },
          historyLength: window.history.length,
          userAgent: navigator.userAgent,
        },
        errors: Array.isArray(diagnostics.errors) ? diagnostics.errors.slice(-${MAX_DIAGNOSTICS_ENTRIES}) : [],
        network: Array.isArray(diagnostics.network) ? diagnostics.network.slice(-${MAX_DIAGNOSTICS_ENTRIES}) : [],
        resources,
      };

      if (payload && payload.clear) {
        diagnostics.errors.length = 0;
        diagnostics.network.length = 0;
        diagnostics.clearedAt = Date.now();
      }

      return result;
    `, { clear: Boolean(options.clear) });
  } catch (error) {
    captureError = error instanceof Error ? error : new Error(String(error));
  }

  const pageUrl = captured?.page.url || readWebviewUrl(webview) || currentUrl.value;
  let pageOrigin: string | null = null;
  try { pageOrigin = pageUrl ? new URL(pageUrl).origin : null; } catch { pageOrigin = null; }

  const page = captured?.page || {
    url: pageUrl,
    title: currentTitle.value,
    origin: pageOrigin,
    readyState: "unavailable",
    visibilityState: "unknown",
    viewport: { width: 0, height: 0, devicePixelRatio: window.devicePixelRatio || 1 },
    scroll: { x: 0, y: 0, width: 0, height: 0 },
    historyLength: 0,
    userAgent: navigator.userAgent,
  };

  const canGoBack = (() => {
    try { return Boolean(webview.canGoBack?.()); } catch { return false; }
  })();
  const canGoForward = (() => {
    try { return Boolean(webview.canGoForward?.()); } catch { return false; }
  })();

  const network = mergeDiagnosticsNetwork([
    ...(captured?.network || []),
    ...(captured?.resources || []),
  ]);

  const runtimeErrors: BrowserAutomationPageError[] = captured?.errors || [];
  if (captureError) {
    runtimeErrors.push({
      kind: "error",
      message: `Page diagnostics could not be collected: ${captureError.message}`,
      timestamp: Date.now(),
    });
  }

  const result: BrowserAutomationDiagnostics = {
    ...page,
    canGoBack,
    canGoForward,
    console: dedupeConsoleEntries([...consoleBuffer]),
    errors: dedupeDiagnosticsErrors([...pageErrorBuffer, ...runtimeErrors]).slice(-MAX_DIAGNOSTICS_ENTRIES),
    network,
    capturedAt: Date.now(),
  };

  if (options.clear) {
    consoleBuffer.length = 0;
    pageErrorBuffer.length = 0;
  }

  return result;
}


function dedupeConsoleEntries (entries: BrowserAutomationConsoleEntry[]): BrowserAutomationConsoleEntry[] {
  const seen = new Set<string>();
  const deduped = entries.filter((entry) => {
    const key = `${entry.level}|${entry.timestamp}|${entry.message}|${entry.source || ""}|${entry.line ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return deduped.slice(-MAX_DIAGNOSTICS_ENTRIES);
}

function mergeDiagnosticsNetwork (entries: BrowserAutomationNetworkEntry[]): BrowserAutomationNetworkEntry[] {
  const sorted = [...entries].sort((left, right) => right.timestamp - left.timestamp);
  const kept: BrowserAutomationNetworkEntry[] = [];

  for (const entry of sorted) {
    const duplicate = kept.some((candidate) => {
      if (candidate.url !== entry.url) return false;
      const sameRequest = candidate.method === entry.method
        && (candidate.status ?? null) === (entry.status ?? null)
        && Math.abs(candidate.timestamp - entry.timestamp) < 1500;
      if (sameRequest) return true;
      const resourceOverlap = isResourceLikeEntry(candidate) || isResourceLikeEntry(entry);
      if (!resourceOverlap) return false;
      return Math.abs(candidate.timestamp - entry.timestamp) < Math.max(2000, (candidate.durationMs || 0) + 1000);
    });
    if (!duplicate) kept.push(entry);
  }

  return kept.slice(0, MAX_DIAGNOSTICS_ENTRIES);
}

function isResourceLikeEntry (entry: BrowserAutomationNetworkEntry): boolean {
  return entry.method == null && entry.status == null;
}

function dedupeDiagnosticsErrors (entries: BrowserAutomationPageError[]): BrowserAutomationPageError[] {
  const byKey = new Map<string, BrowserAutomationPageError>();
  for (const entry of entries) {
    const key = `${entry.kind}|${entry.message}|${entry.source || ""}|${entry.line ?? ""}|${entry.column ?? ""}`;
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function normalizeScreenshotQuality(value?: number): number {
  return Math.max(10, Math.min(Math.round(Number(value) || 80), 100));
}

const SCREENSHOT_MAX_HEIGHT = 16000;
const SCREENSHOT_MAX_PIXELS = 25_000_000;

function screenshotExceedsCaps(width: number, height: number, maxWidth: number): boolean {
  return width > maxWidth
    || height > SCREENSHOT_MAX_HEIGHT
    || width * height > SCREENSHOT_MAX_PIXELS;
}

async function renderScreenshotDataUrl(
  dataUrl: string,
  maxWidth: number,
  format: "png" | "jpeg",
  quality: number,
  allowFormatConversion: boolean,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = dataUrl;
    await image.decode();
    const naturalWidth = image.naturalWidth || image.width;
    const naturalHeight = image.naturalHeight || image.height;
    if (!naturalWidth || !naturalHeight) return null;
    const scale = Math.min(
      1,
      maxWidth / naturalWidth,
      SCREENSHOT_MAX_HEIGHT / naturalHeight,
      Math.sqrt(SCREENSHOT_MAX_PIXELS / (naturalWidth * naturalHeight)),
    );
    const width = Math.max(1, Math.floor(naturalWidth * scale));
    const height = Math.max(1, Math.floor(naturalHeight * scale));
    const needsFormatConversion = allowFormatConversion && format === "jpeg";
    if (width >= naturalWidth && height >= naturalHeight && !needsFormatConversion) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    if (format === "jpeg") {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(image, 0, 0, width, height);
    return {
      dataUrl: canvas.toDataURL(format === "jpeg" ? "image/jpeg" : "image/png", quality / 100),
      width,
      height,
    };
  } catch {
    return null;
  }
}

async function captureScreenshot(options: {
  fullPage?: boolean;
  maxWidth?: number;
  format?: "png" | "jpeg";
  quality?: number;
} = {}): Promise<BrowserAutomationScreenshot> {
  const webview = webviewRef.value;
  if (!webview) {
    throw new Error("Page screenshots are unavailable for this page surface.");
  }

  const maxWidth = Math.max(320, Math.min(Number(options.maxWidth) || 1280, 4096));
  const format = options.format === "jpeg" ? "jpeg" : "png";
  const quality = normalizeScreenshotQuality(options.quality);
  const title = currentTitle.value;
  const url = readWebviewUrl(webview) || currentUrl.value;
  const fullPage = Boolean(options.fullPage);
  let note: string | undefined;

  if (fullPage) {
    const webContentsId = getWebContentsId();
    const capture = window.electronAPI?.captureBrowserPageScreenshot;
    if (webContentsId && capture) {
      try {
        const shot = await capture({
          webContentsId,
          fullPage: true,
          format,
          quality,
        });
        if (shot?.dataUrl) {
          let dataUrl = shot.dataUrl;
          let width = shot.width;
          let height = shot.height;
          const scaled = screenshotExceedsCaps(width, height, maxWidth)
            ? await renderScreenshotDataUrl(dataUrl, maxWidth, format, quality, false)
            : null;
          if (scaled) {
            dataUrl = scaled.dataUrl;
            width = scaled.width;
            height = scaled.height;
          }
          const scalingNote = screenshotExceedsCaps(width, height, maxWidth)
            ? `Full-page screenshot is ${width}x${height}px; it exceeded the ${maxWidth}px width, ${SCREENSHOT_MAX_HEIGHT}px height, or ${SCREENSHOT_MAX_PIXELS}px pixel cap and could not be scaled further.`
            : undefined;
          return {
            url,
            title,
            dataUrl,
            width,
            height,
            fullPage: shot.fullPage !== false,
            ...(shot.note || scalingNote ? { note: [shot.note, scalingNote].filter(Boolean).join(" ") } : {}),
            capturedAt: Date.now(),
          };
        }
        note = "Full-page capture returned no image; returned the visible viewport instead.";
      } catch (error) {
        note = `Full-page capture failed (${error instanceof Error ? error.message : String(error)}); returned the visible viewport instead.`;
      }
    } else {
      note = "Full-page capture is unavailable for this page surface; returned the visible viewport instead.";
    }
  }

  if (!webview.capturePage) {
    throw new Error("This browser surface does not support screenshots.");
  }

  let image = await webview.capturePage();
  let size = image.getSize();
  let dataUrl = image.toDataURL();
  const converted = screenshotExceedsCaps(size.width, size.height, maxWidth) || format === "jpeg"
    ? await renderScreenshotDataUrl(dataUrl, maxWidth, format, quality, true)
    : null;
  if (converted) {
    dataUrl = converted.dataUrl;
    size = { width: converted.width, height: converted.height };
  } else if (screenshotExceedsCaps(size.width, size.height, maxWidth)) {
    note = [note, `Viewport screenshot is ${size.width}x${size.height}px; it exceeded the ${maxWidth}px width, ${SCREENSHOT_MAX_HEIGHT}px height, or ${SCREENSHOT_MAX_PIXELS}px pixel cap and could not be scaled further.`]
      .filter(Boolean)
      .join(" ");
  }

  return {
    url,
    title,
    dataUrl,
    width: size.width,
    height: size.height,
    fullPage: false,
    ...(note ? { note } : {}),
    capturedAt: Date.now(),
  };
}

interface WebviewLoadWaiter {
  promise: Promise<void>;
  cancel: () => void;
  fail: (error: Error) => void;
}

function waitForWebviewLoad(webview: WebviewLikeElement, timeoutMs = 15000): WebviewLoadWaiter {
  let settled = false;
  let timer: number | null = null;
  let pollTimer: number | null = null;
  let resolvePromise: (() => void) | null = null;
  let rejectPromise: ((error: Error) => void) | null = null;
  const initialUrl = readWebviewUrl(webview) || "";
  let sawLoading = false;
  try { sawLoading = Boolean(webview.isLoading?.()); } catch { sawLoading = false; }

  const cleanup = () => {
    webview.removeEventListener("did-start-loading", onStart as EventListener);
    webview.removeEventListener("did-stop-loading", onStop as EventListener);
    webview.removeEventListener("did-navigate-in-page", onNavigateInPage as EventListener);
    webview.removeEventListener("did-fail-load", onFail as EventListener);
    if (timer != null) {
      window.clearTimeout(timer);
      timer = null;
    }
    if (pollTimer != null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const settle = (error?: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectPromise?.(error);
    else resolvePromise?.();
  };

  const onStart = () => {
    sawLoading = true;
  };
  const onStop = () => settle();
  const onNavigateInPage = () => {
    window.setTimeout(() => {
      if (settled) return;
      let loading = false;
      try { loading = Boolean(webview.isLoading?.()); } catch { loading = false; }
      if (!loading) settle();
    }, 80);
  };
  const onFail = (event: Event) => {
    const payload = event as Event & {
      errorCode?: number;
      errorDescription?: string;
      validatedURL?: string;
      isMainFrame?: boolean;
    };
    if (payload.isMainFrame === false) return;
    const errorCode = Number(payload.errorCode);
    if (errorCode === -3) return;
    const description = payload.errorDescription || `Navigation failed (${payload.errorCode ?? "unknown"})`;
    settle(new Error(payload.validatedURL ? `${description}: ${payload.validatedURL}` : description));
  };

  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  webview.addEventListener("did-start-loading", onStart as EventListener);
  webview.addEventListener("did-stop-loading", onStop as EventListener);
  webview.addEventListener("did-navigate-in-page", onNavigateInPage as EventListener);
  webview.addEventListener("did-fail-load", onFail as EventListener);

  const effectiveTimeout = Math.max(1000, Math.min(Number(timeoutMs) || 15000, 25000));
  timer = window.setTimeout(() => {
    settle(new Error(`Timed out after ${effectiveTimeout}ms waiting for the page to finish loading.`));
  }, effectiveTimeout);

  pollTimer = window.setInterval(() => {
    if (settled) return;
    let loading = false;
    try { loading = Boolean(webview.isLoading?.()); } catch { loading = false; }
    if (loading) {
      sawLoading = true;
      return;
    }
    if (sawLoading) {
      settle();
      return;
    }
    const currentUrlValue = readWebviewUrl(webview);
    if (currentUrlValue && currentUrlValue !== initialUrl) settle();
  }, 120);

  return {
    promise,
    cancel: () => settle(),
    fail: (error: Error) => settle(error),
  };
}

const NAVIGATION_GRACE_MS = 450;

interface NavigationOutcome {
  navigated: boolean;
  url?: string;
  timedOut?: boolean;
  error?: string;
}

interface NavigationWatcher {
  start: () => Promise<NavigationOutcome>;
  cancel: () => void;
}

type NavigationAwareActionResult = BrowserAutomationActionResult & {
  navigated?: boolean;
  navigationTimedOut?: boolean;
};

function watchForNavigation(webview: WebviewLikeElement, timeoutMs = 15000): NavigationWatcher {
  const initialUrl = readWebviewUrl(webview) || "";
  let started = false;
  let finished = false;
  let navigated = false;
  let startedAt = 0;
  let pollTimer: number | null = null;
  let timeoutTimer: number | null = null;
  let resolveOutcome: ((outcome: NavigationOutcome) => void) | null = null;
  const effectiveTimeout = Math.max(1000, Math.min(Number(timeoutMs) || 15000, 25000));

  const currentUrl = () => readWebviewUrl(webview) || initialUrl;
  const isLoadingNow = () => {
    try { return Boolean(webview.isLoading?.()); } catch { return false; }
  };

  const cleanup = () => {
    webview.removeEventListener("did-start-navigation", onStartNavigation as EventListener);
    webview.removeEventListener("did-navigate", onNavigate as EventListener);
    webview.removeEventListener("did-navigate-in-page", onInPageNavigate as EventListener);
    webview.removeEventListener("did-stop-loading", onStop as EventListener);
    webview.removeEventListener("did-fail-load", onFail as EventListener);
    if (pollTimer != null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    if (timeoutTimer != null) {
      window.clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
  };

  const finish = (outcome: NavigationOutcome) => {
    if (finished) return;
    finished = true;
    cleanup();
    resolveOutcome?.(outcome);
  };

  const evaluate = () => {
    if (!started || finished) return;
    const url = currentUrl();
    if (url && url !== initialUrl) navigated = true;
    if (navigated && !isLoadingNow()) {
      finish({ navigated: true, url });
      return;
    }
    if (!navigated && Date.now() - startedAt >= NAVIGATION_GRACE_MS) {
      finish({ navigated: false, url });
    }
  };

  const onStartNavigation = (event: Event) => {
    const payload = event as Event & { isMainFrame?: boolean };
    if (payload.isMainFrame === false) return;
    navigated = true;
  };
  const onNavigate = () => {
    navigated = true;
  };
  const onInPageNavigate = () => {
    navigated = true;
    evaluate();
  };
  const onStop = () => evaluate();
  const onFail = (event: Event) => {
    const payload = event as Event & {
      errorCode?: number;
      errorDescription?: string;
      validatedURL?: string;
      isMainFrame?: boolean;
    };
    if (payload.isMainFrame === false) return;
    if (Number(payload.errorCode) === -3) return;
    navigated = true;
    finish({
      navigated: true,
      url: payload.validatedURL || currentUrl(),
      error: payload.errorDescription || `Navigation failed (${payload.errorCode ?? "unknown"})`,
    });
  };

  const promise = new Promise<NavigationOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  const start = () => {
    if (!started) {
      started = true;
      startedAt = Date.now();
      evaluate();
      if (!finished) {
        pollTimer = window.setInterval(evaluate, 80);
        timeoutTimer = window.setTimeout(() => {
          finish({ navigated, url: currentUrl(), timedOut: navigated });
        }, effectiveTimeout);
      }
    }
    return promise;
  };

  const cancel = () => {
    finish({ navigated: false, url: currentUrl() });
  };

  webview.addEventListener("did-start-navigation", onStartNavigation as EventListener);
  webview.addEventListener("did-navigate", onNavigate as EventListener);
  webview.addEventListener("did-navigate-in-page", onInPageNavigate as EventListener);
  webview.addEventListener("did-stop-loading", onStop as EventListener);
  webview.addEventListener("did-fail-load", onFail as EventListener);

  return { start, cancel };
}

function withNavigationOutcome(
  result: BrowserAutomationActionResult,
  outcome: NavigationOutcome,
): NavigationAwareActionResult {
  const notes: string[] = [];
  if (outcome.timedOut) notes.push("Navigation was detected but did not finish within the action timeout.");
  if (outcome.error) notes.push(`Navigation failed: ${outcome.error}`);
  return {
    ...result,
    navigated: outcome.navigated,
    ...(outcome.timedOut ? { navigationTimedOut: true } : {}),
    ...(outcome.url ? { url: outcome.url } : {}),
    ...(result.note || notes.length
      ? { note: [result.note, ...notes].filter(Boolean).join(" ") }
      : {}),
  };
}

interface NavigationWaitTarget {
  state?: "load" | "domcontentloaded";
  url?: string;
}

async function waitForNavigationCondition(
  webview: WebviewLikeElement,
  target: NavigationWaitTarget,
  timeoutMs: number,
): Promise<void> {
  const effectiveTimeout = Math.max(100, Math.min(Number(timeoutMs) || 10000, 25000));
  const check = () => {
    if (target.url) {
      const url = readWebviewUrl(webview);
      if (!url || !url.includes(target.url)) return false;
    }
    if (target.state) {
      let loading = false;
      try { loading = Boolean(webview.isLoading?.()); } catch { loading = false; }
      if (loading) return false;
    }
    return true;
  };

  if (check()) return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let pollTimer: number | null = null;
    let timeoutTimer: number | null = null;
    const cleanup = () => {
      webview.removeEventListener("did-start-loading", evaluate as EventListener);
      webview.removeEventListener("did-stop-loading", evaluate as EventListener);
      webview.removeEventListener("did-navigate", evaluate as EventListener);
      webview.removeEventListener("did-navigate-in-page", evaluate as EventListener);
      webview.removeEventListener("did-fail-load", onFail as EventListener);
      if (pollTimer != null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
      if (timeoutTimer != null) {
        window.clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const evaluate = () => {
      if (check()) finish();
    };
    const onFail = (event: Event) => {
      const payload = event as Event & {
        errorCode?: number;
        errorDescription?: string;
        isMainFrame?: boolean;
      };
      if (payload.isMainFrame === false) return;
      if (Number(payload.errorCode) === -3) return;
      if (target.state) {
        finish(new Error(payload.errorDescription || `Page load failed (${payload.errorCode ?? "unknown"})`));
        return;
      }
      evaluate();
    };

    webview.addEventListener("did-start-loading", evaluate as EventListener);
    webview.addEventListener("did-stop-loading", evaluate as EventListener);
    webview.addEventListener("did-navigate", evaluate as EventListener);
    webview.addEventListener("did-navigate-in-page", evaluate as EventListener);
    webview.addEventListener("did-fail-load", onFail as EventListener);
    pollTimer = window.setInterval(evaluate, 120);
    timeoutTimer = window.setTimeout(() => {
      const parts: string[] = [];
      if (target.url) parts.push(`URL containing "${target.url}"`);
      if (target.state) parts.push(`document state "${target.state}"`);
      finish(new Error(`wait_for timed out after ${effectiveTimeout}ms waiting for ${parts.join(" and ") || "the page"}.`));
    }, effectiveTimeout);
    evaluate();
  });
}

async function waitForPageCondition(
  webview: WebviewLikeElement,
  action: Extract<BrowserAutomationAction, { type: "wait_for" }>,
  timeoutMs: number,
): Promise<BrowserAutomationActionResult> {
  return await executeInPage<BrowserAutomationActionResult>(`
    ${PAGE_SCRIPT_HELPERS}
    const startedAt = Date.now();
    const timeoutMs = Math.max(100, Math.min(Number(payload.timeoutMs) || 10000, 25000));
    const matches = () => {
      if (payload.ref) {
        if (!document.querySelector('[data-worldbase-ref="' + CSS.escape(String(payload.ref)) + '"]')) return false;
      } else if (payload.selector) {
        if (!document.querySelector(payload.selector)) return false;
      }
      if (payload.text) {
        const haystack = document.body?.innerText || document.body?.textContent || '';
        if (!String(haystack).includes(payload.text)) return false;
      }
      return true;
    };
    while (!matches()) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('wait_for timed out after ' + timeoutMs + 'ms');
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return { ok: true, type: payload.type, timeoutMs: Date.now() - startedAt, url: location.href };
  `, { ...action, timeoutMs });
}

async function runWaitForAction(
  webview: WebviewLikeElement,
  action: Extract<BrowserAutomationAction, { type: "wait_for" }>,
): Promise<BrowserAutomationActionResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(100, Math.min(Number(action.timeoutMs) || 10000, 25000));
  if (action.state || action.url) {
    await waitForNavigationCondition(webview, { state: action.state, url: action.url }, timeoutMs);
  }
  const elapsed = Date.now() - startedAt;
  const remaining = Math.max(100, timeoutMs - elapsed);
  if (!action.selector && !action.ref && !action.text) {
    return { ok: true, type: "wait_for", timeoutMs: elapsed, url: readWebviewUrl(webview) };
  }
  const result = await waitForPageCondition(webview, action, remaining);
  return { ...result, timeoutMs: Date.now() - startedAt };
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function measurePageViewport(): Promise<{ width: number; height: number } | null> {
  try {
    return await executeInPage<{ width: number; height: number }>(`
      return {
        width: Math.max(0, Math.round(window.innerWidth)),
        height: Math.max(0, Math.round(window.innerHeight)),
      };
    `);
  } catch {
    return null;
  }
}

async function applyAgentViewport(width?: number, height?: number, reset = false): Promise<{ width?: number; height?: number }> {
  const measuredBefore = await measurePageViewport();

  if (reset) {
    agentViewport.value = null;
    await nextTick();
    await nextAnimationFrame();
    await nextAnimationFrame();
    return (await measurePageViewport()) || measuredBefore || {};
  }

  const hasWidth = typeof width === "number" && Number.isFinite(width) && width > 0;
  const hasHeight = typeof height === "number" && Number.isFinite(height) && height > 0;
  if (!hasWidth && !hasHeight) {
    return measuredBefore || agentViewport.value || {};
  }

  const base = measuredBefore || agentViewport.value || { width: 1280, height: 800 };
  const next = {
    width: Math.round(Math.max(320, Math.min(hasWidth ? width : base.width, 4096))),
    height: Math.round(Math.max(240, Math.min(hasHeight ? height : base.height, 4096))),
  };
  agentViewport.value = next;
  await nextTick();
  await nextAnimationFrame();
  await nextAnimationFrame();
  return (await measurePageViewport()) || next;
}

function toElectronModifiers(modifiers?: string[]): Array<"alt" | "control" | "meta" | "shift"> {
  const normalized = new Set<"alt" | "control" | "meta" | "shift">();
  for (const modifier of modifiers || []) {
    const value = modifier.toLowerCase();
    if (value === "alt" || value === "option") normalized.add("alt");
    else if (value === "control" || value === "ctrl") normalized.add("control");
    else if (value === "meta" || value === "cmd" || value === "command") normalized.add("meta");
    else if (value === "shift") normalized.add("shift");
  }
  return [...normalized];
}

function normalizeElectronKey(key: string): string {
  if (key === "Space" || key === "space" || key === " ") return "Space";
  if (key === "Esc") return "Escape";
  if (key === "Return") return "Enter";
  if (key.startsWith("Arrow")) return key.slice("Arrow".length);
  return key;
}

function electronCharForKey(key: string, shift: boolean): string | null {
  if (key === "Space" || key === "space" || key === " ") return " ";
  if (Array.from(key).length !== 1) return null;
  if (shift && /^[a-z]$/.test(key)) return key.toUpperCase();
  return key;
}

function focusWebviewForInput(webview: WebviewLikeElement): void {
  try {
    webview.focus({ preventScroll: true });
  } catch {
    try { webview.focus(); } catch { /* best effort */ }
  }
}

function webviewZoomFactor(webview: WebviewLikeElement): number {
  try {
    const factor = webview.getZoomFactor?.();
    return typeof factor === "number" && Number.isFinite(factor) && factor > 0 ? factor : 1;
  } catch {
    return 1;
  }
}

async function sendRealKey(
  webview: WebviewLikeElement,
  key: string,
  modifiers?: string[],
): Promise<void> {
  if (!webview.sendInputEvent) throw new Error("Real keyboard input is unavailable on this page surface.");
  const keyCode = normalizeElectronKey(key);
  const electronModifiers = toElectronModifiers(modifiers);
  const hasCommandModifier = electronModifiers.includes("control")
    || electronModifiers.includes("meta")
    || electronModifiers.includes("alt");
  const char = hasCommandModifier ? null : electronCharForKey(key, electronModifiers.includes("shift"));
  await webview.sendInputEvent({ type: "keyDown", keyCode, modifiers: electronModifiers });
  if (char) {
    await webview.sendInputEvent({ type: "char", keyCode: char, modifiers: electronModifiers });
  }
  await webview.sendInputEvent({ type: "keyUp", keyCode, modifiers: electronModifiers });
}

async function prepareRealTarget(
  target: { selector?: string; ref?: string },
): Promise<{ x: number; y: number; width: number; height: number }> {
  return await executeInPage<{ x: number; y: number; width: number; height: number }>(`
    ${PAGE_SCRIPT_HELPERS}
    const element = resolveTarget(payload.target);
    if (!isElementVisible(element)) {
      throw new Error('Element is not visible: ' + (payload.target.ref || payload.target.selector));
    }
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await Promise.race([
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))),
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
    if (!isElementVisible(element)) {
      throw new Error('Element is not visible after scrolling: ' + (payload.target.ref || payload.target.selector));
    }
    const rect = element.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
      throw new Error('Element center is outside the visible viewport.');
    }
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== element && !element.contains(hit))) {
      throw new Error('Element is covered by another element at its center point.');
    }
    return {
      x,
      y,
      width: rect.width,
      height: rect.height,
    };
  `, { target });
}

async function dispatchRealPointerAction(
  webview: WebviewLikeElement,
  action: { type: "click" | "hover"; selector?: string; ref?: string },
  rect: { x: number; y: number; width: number; height: number },
): Promise<BrowserAutomationActionResult> {
  if (!webview.sendInputEvent) {
    throw new Error("Real pointer input is unavailable on this page surface.");
  }
  focusWebviewForInput(webview);
  const zoom = webviewZoomFactor(webview);
  const x = Math.round(rect.x * zoom);
  const y = Math.round(rect.y * zoom);
  await webview.sendInputEvent({ type: "mouseMove", x, y });
  if (action.type === "hover") {
    return { ok: true, type: action.type, selector: action.selector, ref: action.ref };
  }
  await webview.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  await webview.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  return { ok: true, type: action.type, selector: action.selector, ref: action.ref };
}

const MAX_ACTION_DEPTH = 4;

interface SerializedPageValue {
  result: unknown;
  resultType: string;
}

function isSyntaxErrorLike(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /SyntaxError|Unexpected token|Unexpected identifier|Unexpected end of input|Invalid or unexpected token|await is only valid|Cannot use 'await'|missing \) after argument list/i.test(message);
}

async function executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: number | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms. The script may still be running in the page.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer != null) window.clearTimeout(timer);
  }
}

async function evaluateScriptInPage(
  webview: WebviewLikeElement,
  script: string,
  timeoutMs?: number,
): Promise<SerializedPageValue> {
  if (typeof webview.executeJavaScript !== "function") {
    throw new Error("Script evaluation is unavailable for this page surface.");
  }

  const trimmed = script.trim();
  if (!trimmed) throw new Error("evaluate requires a non-empty script string.");

  const effectiveTimeout = Math.max(1000, Math.min(Number(timeoutMs) || 10000, 25000));
  const looksLikeFunction = /^(async\s+)?function\b/.test(trimmed)
    || /^(async\s+)?\([\s\S]*\)\s*=>/.test(trimmed)
    || /^(async\s+)?[\w$]+\s*=>/.test(trimmed);

  const buildScript = (body: string) => `(async () => {
    ${PAGE_SERIALIZE_RESULT_SCRIPT}
    ${body}
  })()`;

  const attempts: string[] = [];
  if (looksLikeFunction) {
    attempts.push(buildScript(`
      const fn = (${trimmed}
      );
      if (typeof fn !== 'function') return serializeResult(fn);
      return serializeResult(await fn());
    `));
  }
  attempts.push(buildScript(`return serializeResult(await (${trimmed}
  ));`));
  attempts.push(buildScript(`return serializeResult(await (async () => { ${trimmed}
  })());`));

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const value = await executeWithTimeout(
        webview.executeJavaScript<SerializedPageValue>(attempt, true),
        effectiveTimeout,
        "evaluate",
      );
      if (value && typeof value === "object" && "result" in value && "resultType" in value) {
        return value as SerializedPageValue;
      }
      return { result: value ?? null, resultType: typeof value };
    } catch (error) {
      lastError = error;
      if (!isSyntaxErrorLike(error)) throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || "evaluate failed."));
}

function canWebviewGo(webview: WebviewLikeElement, direction: "back" | "forward"): boolean {
  try {
    return direction === "back" ? Boolean(webview.canGoBack?.()) : Boolean(webview.canGoForward?.());
  } catch {
    return false;
  }
}

const EMULATION_VIEWPORT_MIN = 320;
const EMULATION_VIEWPORT_MAX = 4096;
const EMULATION_SCALE_MIN = 0.5;
const EMULATION_SCALE_MAX = 4;

function normalizeEmulationDimension(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return Math.round(Math.max(EMULATION_VIEWPORT_MIN, Math.min(fallback, EMULATION_VIEWPORT_MAX)));
  }
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  if (value < EMULATION_VIEWPORT_MIN || value > EMULATION_VIEWPORT_MAX) {
    throw new Error(`${label} must be between ${EMULATION_VIEWPORT_MIN} and ${EMULATION_VIEWPORT_MAX} CSS pixels.`);
  }
  return Math.round(value);
}

function normalizeEmulationScale(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < EMULATION_SCALE_MIN || value > EMULATION_SCALE_MAX) {
    throw new Error(`Emulated device scale factor must be between ${EMULATION_SCALE_MIN} and ${EMULATION_SCALE_MAX}.`);
  }
  return value;
}

function normalizeEmulationMobile(value: boolean | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error("Emulated mobile flag must be a boolean.");
  return value;
}

async function runEmulationAction(action: BrowserAutomationEmulateAction): Promise<BrowserAutomationActionResult> {
  const emulate = window.electronAPI?.emulateBrowserPage;
  if (!emulate) {
    throw new Error("Page emulation is unavailable: the emulateBrowserPage IPC bridge is missing.");
  }
  const webContentsId = getWebContentsId();
  if (webContentsId == null) {
    throw new Error("Page emulation is unavailable before the browser page finishes attaching.");
  }

  if (action.reset === true) {
    const result = await emulate({ webContentsId, reset: true });
    const size = await applyAgentViewport(undefined, undefined, true);
    return {
      ok: true,
      type: "emulate",
      ...(size.width != null ? { width: size.width } : {}),
      ...(size.height != null ? { height: size.height } : {}),
      emulated: result.emulated,
    };
  }

  if (action.media !== undefined && action.media !== "screen" && action.media !== "print") {
    throw new Error(`Unsupported emulated media type: ${String(action.media)}.`);
  }
  if (
    action.colorScheme !== undefined &&
    action.colorScheme !== "light" &&
    action.colorScheme !== "dark" &&
    action.colorScheme !== "no-preference"
  ) {
    throw new Error(`Unsupported emulated color scheme: ${String(action.colorScheme)}.`);
  }
  if (
    action.reducedMotion !== undefined &&
    action.reducedMotion !== "reduce" &&
    action.reducedMotion !== "no-preference"
  ) {
    throw new Error(`Unsupported emulated reduced-motion value: ${String(action.reducedMotion)}.`);
  }
  if (action.userAgent !== undefined && (typeof action.userAgent !== "string" || !action.userAgent.trim())) {
    throw new Error("Emulated user agent must be a non-empty string.");
  }

  const current = await emulate({ webContentsId });
  const currentViewport = current.emulated?.viewport;
  const hasViewportFields = action.width !== undefined
    || action.height !== undefined
    || action.deviceScaleFactor !== undefined
    || action.mobile !== undefined;

  let viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    mobile: boolean;
  } | undefined;

  if (hasViewportFields) {
    const measured = action.width === undefined || action.height === undefined
      ? await measurePageViewport()
      : null;
    const baseWidth = currentViewport?.width ?? agentViewport.value?.width ?? measured?.width ?? 1280;
    const baseHeight = currentViewport?.height ?? agentViewport.value?.height ?? measured?.height ?? 800;
    viewport = {
      width: normalizeEmulationDimension(action.width, baseWidth, "Emulated viewport width"),
      height: normalizeEmulationDimension(action.height, baseHeight, "Emulated viewport height"),
      deviceScaleFactor: normalizeEmulationScale(action.deviceScaleFactor, currentViewport?.deviceScaleFactor ?? 1),
      mobile: normalizeEmulationMobile(action.mobile, currentViewport?.mobile ?? false),
    };
  }

  const hasOverrides = action.media !== undefined
    || action.colorScheme !== undefined
    || action.reducedMotion !== undefined
    || action.userAgent !== undefined
    || viewport !== undefined;

  if (!hasOverrides) {
    const size = currentViewport ?? agentViewport.value ?? await measurePageViewport();
    return {
      ok: true,
      type: "emulate",
      ...(size?.width != null ? { width: size.width } : {}),
      ...(size?.height != null ? { height: size.height } : {}),
      emulated: current.emulated,
    };
  }

  const result = await emulate({
    webContentsId,
    ...(action.media !== undefined ? { media: action.media } : {}),
    ...(action.colorScheme !== undefined ? { colorScheme: action.colorScheme } : {}),
    ...(action.reducedMotion !== undefined ? { reducedMotion: action.reducedMotion } : {}),
    ...(action.userAgent !== undefined ? { userAgent: action.userAgent } : {}),
    ...(viewport ? { viewport } : {}),
  });

  const size = viewport
    ? await applyAgentViewport(viewport.width, viewport.height)
    : currentViewport ?? agentViewport.value ?? await measurePageViewport();
  const emulatedViewport = result.emulated?.viewport;

  return {
    ok: true,
    type: "emulate",
    ...(emulatedViewport?.width != null ? { width: emulatedViewport.width } : size?.width != null ? { width: size.width } : {}),
    ...(emulatedViewport?.height != null ? { height: emulatedViewport.height } : size?.height != null ? { height: size.height } : {}),
    emulated: result.emulated,
  };
}

async function runAutomationAction(action: BrowserAutomationAction): Promise<BrowserAutomationActionResult> {
  return await runAutomationActionInternal(action, 0);
}

async function runAutomationActionInternal(
  action: BrowserAutomationAction,
  depth: number,
): Promise<BrowserAutomationActionResult> {
  const webview = webviewRef.value;
  if (!webview) {
    throw new Error("Browser automation is unavailable for this page surface.");
  }
  if (depth > MAX_ACTION_DEPTH) {
    throw new Error(`Batch actions are nested too deeply (max ${MAX_ACTION_DEPTH}).`);
  }

  if (action.type === "batch") {
    const results: BrowserAutomationActionResult[] = [];
    for (const [index, step] of action.actions.entries()) {
      try {
        const result = await runAutomationActionInternal(step, depth + 1);
        results.push(result);
        const navigationTimedOut = (result as NavigationAwareActionResult).navigationTimedOut === true;
        if (result.ok === false || navigationTimedOut) {
          return {
            ok: false,
            type: "batch",
            completed: index,
            results,
            error: result.error
              || (navigationTimedOut
                ? `Batch step ${index + 1} triggered a navigation that did not finish.`
                : `Batch step ${index + 1} failed.`),
          };
        }
      } catch (error) {
        return {
          ok: false,
          type: "batch",
          completed: index,
          results,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { ok: true, type: "batch", completed: results.length, results };
  }

  if (action.type === "wait_for") {
    return await runWaitForAction(webview, action);
  }

  if (action.type === "evaluate") {
    const serialized = await evaluateScriptInPage(webview, action.script, action.timeoutMs);
    return {
      ok: true,
      type: "evaluate",
      result: serialized.result,
      resultType: serialized.resultType,
    };
  }

  if (action.type === "navigate") {
    const target = normalizeWebUrlInput(action.url);
    if (!target) throw new Error(`Invalid page URL: ${action.url}`);
    const waiter = waitForWebviewLoad(webview, action.timeoutMs ?? 15000);
    currentUrl.value = target;
    addressInput.value = target;
    emitStateChange();
    try {
      if (typeof webview.loadURL === "function") {
        const loadResult = webview.loadURL(target);
        if (loadResult && typeof loadResult.catch === "function") {
          loadResult.catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (/ERR_ABORTED|\(-3\)/.test(message)) return;
            waiter.fail(error instanceof Error ? error : new Error(String(error)));
          });
        }
      } else {
        webview.src = target;
      }
      await waiter.promise;
    } catch (error) {
      waiter.cancel();
      syncFromWebview();
      throw error;
    }
    syncFromWebview();
    return { ok: true, type: action.type, url: readWebviewUrl(webview) || target };
  }

  if (action.type === "reload") {
    const waiter = waitForWebviewLoad(webview, action.timeoutMs ?? 15000);
    try {
      if (action.ignoreCache && typeof webview.reloadIgnoringCache === "function") {
        webview.reloadIgnoringCache();
      } else if (typeof webview.reload === "function") {
        webview.reload();
      } else {
        loadUrlInWebview(currentUrl.value);
      }
      await waiter.promise;
    } catch (error) {
      waiter.cancel();
      syncFromWebview();
      throw error;
    }
    syncFromWebview();
    return { ok: true, type: action.type, url: readWebviewUrl(webview) };
  }

  if (action.type === "back" || action.type === "forward") {
    if (!canWebviewGo(webview, action.type)) {
      throw new Error(`Cannot go ${action.type}: no ${action.type} history entry is available.`);
    }
    const waiter = waitForWebviewLoad(webview, action.timeoutMs ?? 15000);
    try {
      if (action.type === "back") webview.goBack?.();
      else webview.goForward?.();
      await waiter.promise;
    } catch (error) {
      waiter.cancel();
      syncFromWebview();
      throw error;
    }
    syncFromWebview();
    return { ok: true, type: action.type, url: readWebviewUrl(webview) };
  }

  if (action.type === "resize") {
    const size = await applyAgentViewport(action.width, action.height, action.reset);
    return { ok: true, type: action.type, width: size.width, height: size.height };
  }

  if (action.type === "emulate") {
    return await runEmulationAction(action);
  }

  let fallbackNote: string | undefined;

  if (action.type === "click" || action.type === "hover") {
    if (webview.sendInputEvent) {
      const rect = await prepareRealTarget(action);
      if (action.type === "hover") {
        return await dispatchRealPointerAction(webview, action, rect);
      }
      const navigation = watchForNavigation(webview, 15000);
      try {
        const result = await dispatchRealPointerAction(webview, action, rect);
        const outcome = await navigation.start();
        return withNavigationOutcome(result, outcome);
      } catch (error) {
        navigation.cancel();
        throw error;
      }
    }
    fallbackNote = "Used synthetic DOM events because native pointer input is unavailable on this page surface.";
  }

  if (action.type === "press_key") {
    if (!action.key) throw new Error("press_key requires a non-empty key.");
    if (webview.sendInputEvent) {
      focusWebviewForInput(webview);
      if (action.selector || action.ref) {
        await executeInPage(`
          ${PAGE_SCRIPT_HELPERS}
          const element = resolveTarget(payload.target);
          element.focus({ preventScroll: true });
          return true;
        `, { target: action });
      }
      const navigation = watchForNavigation(webview, 15000);
      try {
        await sendRealKey(webview, action.key, action.modifiers);
        const outcome = await navigation.start();
        return withNavigationOutcome(
          { ok: true, type: action.type, selector: action.selector, ref: action.ref, key: action.key },
          outcome,
        );
      } catch (error) {
        navigation.cancel();
        throw error;
      }
    }
    fallbackNote = "Used synthetic keyboard events because native keyboard input is unavailable on this page surface.";
  }

  const navigation = action.type === "click" || action.type === "press_key"
    ? watchForNavigation(webview, 15000)
    : null;
  let result: BrowserAutomationActionResult;
  try {
    result = await executeInPage<BrowserAutomationActionResult>(`
    ${PAGE_SCRIPT_HELPERS}

    const setNativeValue = (element, value) => {
      const prototype = Object.getPrototypeOf(element);
      const prototypeDescriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
      const ownDescriptor = Object.getOwnPropertyDescriptor(element, 'value');
      const descriptor = prototypeDescriptor && prototypeDescriptor.set ? prototypeDescriptor : ownDescriptor;
      if (descriptor && descriptor.set) descriptor.set.call(element, value);
      else element.value = value;
    };

    const dispatchInput = (element, data, inputType) => {
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        data: data,
        inputType: inputType || 'insertText',
      }));
    };

    const setContentEditableValue = (element, text, append) => {
      element.focus();
      const selection = window.getSelection();
      if (!selection) throw new Error('The page did not expose a text selection.');
      const range = document.createRange();
      range.selectNodeContents(element);
      if (append) range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, text);
      } catch {
        inserted = false;
      }
      if (!inserted) {
        element.textContent = (append ? String(element.textContent || '') : '') + text;
        dispatchInput(element, text, 'insertText');
      }
      return String(element.textContent || '').length;
    };

    const setInputValue = (element, text, append) => {
      if (element.isContentEditable) {
        return setContentEditableValue(element, text, append);
      }
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        throw new Error('Selected element does not accept text input: ' + element.outerHTML.slice(0, 120));
      }
      element.focus();
      const nextValue = append ? ((element.value || '') + text) : text;
      setNativeValue(element, nextValue);
      dispatchInput(element, text, 'insertText');
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return nextValue.length;
    };

    const setSelectValue = (element, value) => {
      setNativeValue(element, String(value));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const dispatchMouseEvent = (element, type) => {
      const rect = element.getBoundingClientRect();
      const clientX = rect.x + rect.width / 2;
      const clientY = rect.y + rect.height / 2;
      const base = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: clientX,
        clientY: clientY,
        screenX: window.screenX + clientX,
        screenY: window.screenY + clientY,
        button: 0,
        buttons: type === 'mousedown' || type === 'pointerdown' ? 1 : 0,
      };
      if (type.startsWith('pointer')) {
        element.dispatchEvent(new PointerEvent(type, {
          ...base,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        }));
      } else {
        element.dispatchEvent(new MouseEvent(type, {
          ...base,
          detail: type === 'click' ? 1 : 0,
        }));
      }
    };

    const dispatchSyntheticClick = (element) => {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      if (typeof element.focus === 'function') element.focus({ preventScroll: true });
      const checkable = element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio');
      dispatchMouseEvent(element, 'pointerover');
      dispatchMouseEvent(element, 'pointerenter');
      dispatchMouseEvent(element, 'pointermove');
      dispatchMouseEvent(element, 'pointerdown');
      dispatchMouseEvent(element, 'mousedown');
      dispatchMouseEvent(element, 'pointerup');
      dispatchMouseEvent(element, 'mouseup');
      if (checkable) {
        element.checked = element.type === 'radio' ? true : !element.checked;
      }
      dispatchMouseEvent(element, 'click');
      if (checkable) {
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };

    const dispatchSyntheticHover = (element) => {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      dispatchMouseEvent(element, 'pointerover');
      dispatchMouseEvent(element, 'pointerenter');
      dispatchMouseEvent(element, 'pointermove');
      dispatchMouseEvent(element, 'mouseover');
      dispatchMouseEvent(element, 'mouseenter');
      dispatchMouseEvent(element, 'mousemove');
    };

    const keyModifierState = (modifiers) => {
      const values = new Set((modifiers || []).map((value) => String(value).toLowerCase()));
      return {
        altKey: values.has('alt') || values.has('option'),
        ctrlKey: values.has('control') || values.has('ctrl'),
        metaKey: values.has('meta') || values.has('cmd') || values.has('command'),
        shiftKey: values.has('shift'),
      };
    };

    const keyCharacter = (key, shiftKey) => {
      if (key === 'Space' || key === 'space' || key === ' ') return ' ';
      if (Array.from(key).length !== 1) return null;
      return shiftKey && /^[a-z]$/.test(key) ? key.toUpperCase() : key;
    };

    const dispatchSyntheticKey = (target, key, modifiers) => {
      if (!target) throw new Error('press_key requires a focused element.');
      const normalizedKey = key === 'Space' || key === 'space' ? ' ' : key === 'Esc' ? 'Escape' : key === 'Return' ? 'Enter' : key;
      const modifierState = keyModifierState(modifiers);
      const singleChar = Array.from(normalizedKey).length === 1;
      const code = singleChar
        ? (/[a-zA-Z]/.test(normalizedKey) ? 'Key' + normalizedKey.toUpperCase() : /[0-9]/.test(normalizedKey) ? 'Digit' + normalizedKey : normalizedKey)
        : normalizedKey === ' ' ? 'Space' : normalizedKey;
      const init = {
        key: normalizedKey,
        code: code,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        ...modifierState,
      };
      const proceed = target.dispatchEvent(new KeyboardEvent('keydown', init));
      const keypressProceed = target.dispatchEvent(new KeyboardEvent('keypress', init));
      const printable = !modifierState.ctrlKey && !modifierState.metaKey && !modifierState.altKey;
      const char = printable ? keyCharacter(normalizedKey, modifierState.shiftKey) : null;

      if (proceed && keypressProceed && printable) {
        if (target.isContentEditable) {
          try {
            if (normalizedKey === 'Backspace') document.execCommand('delete');
            else if (normalizedKey === 'Delete') document.execCommand('forwardDelete');
            else if (normalizedKey === 'Enter') document.execCommand('insertLineBreak');
            else if (char) document.execCommand('insertText', false, char);
          } catch {
            // Best-effort: the synthetic key events still reached listeners.
          }
        } else if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          let nextValue = null;
          let nextCaret = start;
          let inputType = 'insertText';
          if (normalizedKey === 'Backspace') {
            const from = start === end ? Math.max(0, start - 1) : start;
            nextValue = target.value.slice(0, from) + target.value.slice(end);
            nextCaret = from;
            inputType = 'deleteContentBackward';
          } else if (normalizedKey === 'Delete') {
            const to = start === end ? Math.min(target.value.length, end + 1) : end;
            nextValue = target.value.slice(0, start) + target.value.slice(to);
            nextCaret = start;
            inputType = 'deleteContentForward';
          } else if (normalizedKey === 'Enter' && target instanceof HTMLTextAreaElement) {
            nextValue = target.value.slice(0, start) + '\\n' + target.value.slice(end);
            nextCaret = start + 1;
            inputType = 'insertLineBreak';
          } else if (char) {
            nextValue = target.value.slice(0, start) + char + target.value.slice(end);
            nextCaret = start + char.length;
          }
          if (nextValue !== null) {
            const beforeInput = new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: inputType,
              data: char,
            });
            if (target.dispatchEvent(beforeInput)) {
              setNativeValue(target, nextValue);
              target.setSelectionRange?.(nextCaret, nextCaret);
              dispatchInput(target, char, inputType);
            }
          }
        }
      }

      target.dispatchEvent(new KeyboardEvent('keyup', init));
      return { key: normalizedKey };
    };

    switch (payload?.type) {
      case 'click': {
        const element = resolveTarget(payload);
        dispatchSyntheticClick(element);
        return { ok: true, type: payload.type, selector: payload.selector, ref: payload.ref };
      }

      case 'input': {
        const element = resolveTarget(payload);
        const textLength = setInputValue(element, payload.text, Boolean(payload.append));
        return { ok: true, type: payload.type, selector: payload.selector, ref: payload.ref, textLength };
      }

      case 'select': {
        const element = resolveTarget(payload);
        if (!(element instanceof HTMLSelectElement)) {
          throw new Error('Selected element is not a <select>: ' + (payload.selector || payload.ref));
        }
        if (typeof payload.value === 'string') {
          setSelectValue(element, payload.value);
        } else if (typeof payload.label === 'string') {
          const match = Array.from(element.options).find((opt) =>
            normalizeText(opt.textContent || '') === payload.label || opt.value === payload.label
          );
          if (!match) throw new Error('No option matched label: ' + payload.label);
          setSelectValue(element, match.value);
        } else if (typeof payload.index === 'number') {
          if (payload.index < 0 || payload.index >= element.options.length) {
            throw new Error('Option index out of range: ' + payload.index);
          }
          setSelectValue(element, element.options[payload.index].value);
        } else {
          throw new Error('select requires value, label, or index');
        }
        return { ok: true, type: payload.type, selector: payload.selector, ref: payload.ref };
      }

      case 'batch_input': {
        if (!Array.isArray(payload.fields)) {
          throw new Error('batch_input requires a fields array');
        }
        let filled = 0;
        let skipped = 0;
        for (const field of payload.fields) {
          let element = null;
          try {
            element = resolveTarget(field);
          } catch {
            skipped++;
            continue;
          }
          try {
            if (element instanceof HTMLSelectElement) {
              setSelectValue(element, field.text);
            } else {
              setInputValue(element, field.text, Boolean(field.append));
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
        if ((payload.selector && String(payload.selector).trim()) || payload.ref) {
          const element = resolveTarget(payload);
          text = normalizeReadableText(element.innerText || element.textContent || '');
        } else {
          text = normalizeReadableText(document.body?.innerText || document.body?.textContent || '');
        }
        const offset = Math.max(0, Number(payload.offset) || 0);
        const rawMaxChars = typeof payload.maxChars === 'number' ? payload.maxChars : null;
        const limit = rawMaxChars === 0 ? 1000000 : rawMaxChars !== null && rawMaxChars > 0 ? Math.min(rawMaxChars, 200000) : 60000;
        const slice = text.slice(offset, offset + limit);
        const truncated = offset + slice.length < text.length;
        return {
          ok: true,
          type: payload.type,
          selector: payload.selector,
          ref: payload.ref,
          text: slice,
          offset,
          truncated,
          totalLength: text.length
        };
      }

      case 'hover': {
        const element = resolveTarget(payload);
        dispatchSyntheticHover(element);
        return { ok: true, type: payload.type, selector: payload.selector, ref: payload.ref };
      }

      case 'focus': {
        const element = resolveTarget(payload);
        element.focus({ preventScroll: true });
        return { ok: true, type: payload.type, selector: payload.selector, ref: payload.ref };
      }

      case 'press_key': {
        if (!payload.key) throw new Error('press_key requires a non-empty key.');
        const target = (payload.selector || payload.ref) ? resolveTarget(payload) : (document.activeElement || document.body);
        if (!target) throw new Error('press_key requires an active element.');
        target.focus?.();
        const keyResult = dispatchSyntheticKey(target, payload.key, payload.modifiers);
        return { ok: true, type: payload.type, selector: payload.selector, ref: payload.ref, key: keyResult.key };
      }

      case 'scroll': {
        window.scrollTo({ top: Number(payload.top) || 0, left: Number(payload.left) || 0, behavior: 'auto' });
        return { ok: true, type: payload.type, top: window.scrollY, left: window.scrollX };
      }

      case 'wait': {
        const waitMs = Math.max(0, Math.min(Number(payload.timeoutMs) || 0, 25000));
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({ ok: true, type: payload.type, timeoutMs: waitMs });
          }, waitMs);
        });
      }

      case 'wait_for': {
        const startedAt = Date.now();
        const timeoutMs = Math.max(100, Math.min(Number(payload.timeoutMs) || 10000, 25000));
        const matches = () => {
          if (payload.ref) {
            if (!document.querySelector('[data-worldbase-ref="' + CSS.escape(String(payload.ref)) + '"]')) return false;
          } else if (payload.selector) {
            if (!document.querySelector(payload.selector)) return false;
          }
          if (payload.text) {
            const haystack = document.body?.innerText || document.body?.textContent || '';
            if (!String(haystack).includes(payload.text)) return false;
          }
          if (payload.url && !location.href.includes(payload.url)) return false;
          if (payload.state === 'load' && document.readyState !== 'complete') return false;
          if (payload.state === 'domcontentloaded' && document.readyState === 'loading') return false;
          return true;
        };
        while (!matches()) {
          if (Date.now() - startedAt > timeoutMs) {
            throw new Error('wait_for timed out after ' + timeoutMs + 'ms');
          }
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        return { ok: true, type: payload.type, timeoutMs: Date.now() - startedAt, url: location.href };
      }

      case 'find': {
        const limit = Math.max(1, Math.min(Number(payload.limit) || 20, 50));
        const nodes = payload.selector
          ? Array.from(document.querySelectorAll(payload.selector))
          : Array.from(document.querySelectorAll('a[href], area[href], button, input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="option"], [role="textbox"], [role="searchbox"], [role="slider"], [role="spinbutton"], [role="treeitem"], [contenteditable]:not([contenteditable="false"]), [onclick]'));
        const role = payload.role ? String(payload.role).toLowerCase() : '';
        const name = payload.name ? String(payload.name).toLowerCase() : '';
        const text = payload.text ? String(payload.text).toLowerCase() : '';
        const matches = [];
        for (const element of nodes) {
          if (role && String(inferredRole(element) || '').toLowerCase() !== role) continue;
          if (name && !accessibleName(element).toLowerCase().includes(name)) continue;
          if (text && !normalizeText(element.textContent || element.getAttribute('value') || '').toLowerCase().includes(text)) continue;
          if (!isElementVisible(element)) continue;
          const tag = element.tagName.toLowerCase();
          const ariaChecked = element.getAttribute('aria-checked');
          matches.push({
            ref: refFor(element),
            selector: buildSelector(element),
            tag,
            text: normalizeText(element.textContent || element.getAttribute('value') || '').slice(0, 240),
            role: inferredRole(element),
            name: accessibleName(element).slice(0, 240),
            type: element instanceof HTMLInputElement
              ? (element.getAttribute('type') || 'text')
              : element instanceof HTMLButtonElement
                ? (element.getAttribute('type') || 'button')
                : element.isContentEditable ? 'contenteditable' : null,
            value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
              ? String(element.value || '').slice(0, 2000)
              : element.isContentEditable
                ? normalizeText(element.innerText || element.textContent || '').slice(0, 2000)
                : null,
            href: elementHref(element),
            placeholder: element.getAttribute('placeholder') || null,
            title: element.getAttribute('title') || null,
            checked: element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')
              ? Boolean(element.checked)
              : ariaChecked === 'true' ? true : ariaChecked === 'false' ? false : null,
            disabled: 'disabled' in element ? Boolean(element.disabled) : element.getAttribute('aria-disabled') === 'true',
            visible: true,
            bounds: elementBounds(element),
          });
          if (matches.length >= limit) break;
        }
        return { ok: true, type: payload.type, matches };
      }

      default:
        throw new Error('Unsupported browser automation action.');
    }
  `, action);
  } catch (error) {
    navigation?.cancel();
    throw error;
  }

  if (navigation) {
    const outcome = await navigation.start();
    const withOutcome = withNavigationOutcome(result, outcome);
    return fallbackNote
      ? { ...withOutcome, note: [withOutcome.note, fallbackNote].filter(Boolean).join(" ") }
      : withOutcome;
  }

  return fallbackNote ? { ...result, note: fallbackNote } : result;
}

function readWebviewUrl (webview: WebviewLikeElement): string | undefined {
  try {
    return webview.getURL() || undefined;
  } catch {
    return undefined;
  }
}

function reloadPage() {
  const webview = webviewRef.value;
  if (!webview) return;
  try {
    if (typeof webview.reload === "function") {
      webview.reload();
      return;
    }
  } catch {
    // Fall through to a URL reload when the webview is mid-navigation.
  }
  loadUrlInWebview(currentUrl.value);
}

const PAGE_CONTEXT_MENU_WIDTH = 200;
const PAGE_CONTEXT_MENU_ITEM_HEIGHT = 32;

/**
 * Collects the live selection and the element under the right-click point.
 * Falls back to the (possibly truncated) selectionText carried by the guest
 * context-menu params when the page is mid-navigation.
 */
async function capturePageContextAtPoint(
  x: number,
  y: number,
): Promise<{ selectionText: string; elementInfo: BrowserContextElementInfo | null }> {
  return await executeInPage<{ selectionText: string; elementInfo: BrowserContextElementInfo | null }>(`
    ${PAGE_SCRIPT_HELPERS}

    let selectionText = '';
    try {
      selectionText = String(window.getSelection() || '');
    } catch {
      selectionText = '';
    }

    let pointElement = null;
    try {
      pointElement = document.elementFromPoint(payload.x, payload.y) || null;
    } catch {
      pointElement = null;
    }

    // Climb a few levels so a click on a short inline node picks up the
    // surrounding text-bearing block instead of a one-word <span>.
    let target = pointElement;
    for (let i = 0; i < 3 && target && target.parentElement; i++) {
      const tag = target.tagName ? target.tagName.toLowerCase() : '';
      if (tag === 'body' || tag === 'html') break;
      const textLength = normalizeText(target.innerText || '').length;
      if (textLength >= 40) break;
      const parent = target.parentElement;
      if (normalizeText(parent.innerText || '').length <= textLength) break;
      target = parent;
    }

    let elementInfo = null;
    if (target && target instanceof Element) {
      const tag = target.tagName ? target.tagName.toLowerCase() : '';
      if (tag !== 'html' && tag !== 'body') {
        elementInfo = {
          selector: buildSelector(target) || '',
          tag,
          text: normalizeText(target.innerText || '').slice(0, ${PAGE_CONTEXT_TEXT_LIMIT}),
        };
      }
    }

    return {
      selectionText: normalizeText(selectionText).slice(0, ${PAGE_CONTEXT_TEXT_LIMIT}),
      elementInfo,
    };
  `, { x, y });
}

function estimatePageContextMenuHeight(): number {
  let items = 1; // the fixed AI-operate entry
  if (pageContextMenu.hasSelection) items += 2;
  else if (pageContextMenu.hasElement) items += 1;
  if (pageContextMenu.hasLink) items += 1;
  return items * PAGE_CONTEXT_MENU_ITEM_HEIGHT + 12;
}

async function handleBrowserPageContextMenu(payload: BrowserPageContextMenuPayload): Promise<void> {
  const webview = webviewRef.value;
  if (!webview || typeof webview.getWebContentsId !== "function") return;

  let ownGuestId: number | null = null;
  try {
    ownGuestId = webview.getWebContentsId();
  } catch {
    return;
  }
  if (ownGuestId !== payload.webContentsId) return;

  const params = payload.params;
  let selectionText = params.selectionText || "";
  let element: BrowserContextElementInfo | null = null;
  try {
    const captured = await capturePageContextAtPoint(params.x, params.y);
    if (captured.selectionText) selectionText = captured.selectionText;
    element = captured.elementInfo;
  } catch {
    // The guest is navigating; keep whatever the params carried.
  }

  pageContextSnapshot = {
    selectionText,
    element,
    linkURL: params.linkURL || "",
  };

  pageContextMenu.copied = false;
  pageContextMenu.hasSelection = selectionText.trim().length > 0;
  pageContextMenu.hasElement = !pageContextMenu.hasSelection && Boolean(element?.text);
  pageContextMenu.hasLink = Boolean(params.linkURL);

  const rect = webview.getBoundingClientRect();
  const menuHeight = estimatePageContextMenuHeight();
  pageContextMenu.x = Math.max(
    8,
    Math.min(rect.left + params.x, window.innerWidth - PAGE_CONTEXT_MENU_WIDTH - 8),
  );
  pageContextMenu.y = Math.max(
    8,
    Math.min(rect.top + params.y, window.innerHeight - menuHeight - 8),
  );
  pageContextMenu.visible = true;
}

function hidePageContextMenu() {
  pageContextMenu.visible = false;
  pageContextMenu.copied = false;
  if (pageContextMenuResetTimer != null) {
    window.clearTimeout(pageContextMenuResetTimer);
    pageContextMenuResetTimer = null;
  }
}

function runPageContextMenuAction(action: () => void | Promise<void>) {
  void (async () => {
    try {
      await action();
    } finally {
      if (pageContextMenuResetTimer == null) hidePageContextMenu();
    }
  })();
}

function copyPageSelection() {
  runPageContextMenuAction(async () => {
    const text = pageContextSnapshot?.selectionText || "";
    if (!text) return;
    await writeTextToClipboard(text);
    pageContextMenu.copied = true;
    if (pageContextMenuResetTimer != null) window.clearTimeout(pageContextMenuResetTimer);
    pageContextMenuResetTimer = window.setTimeout(() => {
      hidePageContextMenu();
    }, 650);
  });
}

function copyPageLink() {
  runPageContextMenuAction(async () => {
    const url = pageContextSnapshot?.linkURL || "";
    if (!url) return;
    await writeTextToClipboard(url);
    pageContextMenu.copied = true;
    if (pageContextMenuResetTimer != null) window.clearTimeout(pageContextMenuResetTimer);
    pageContextMenuResetTimer = window.setTimeout(() => {
      hidePageContextMenu();
    }, 650);
  });
}

function addPageContentToContext() {
  const snapshot = pageContextSnapshot;
  if (!snapshot) return;
  hidePageContextMenu();

  if (snapshot.selectionText.trim()) {
    emit("contextAdd", {
      kind: "selection",
      url: currentUrl.value,
      title: currentTitle.value,
      text: snapshot.selectionText,
    });
    return;
  }
  if (snapshot.element?.text) {
    emit("contextAdd", {
      kind: "element",
      url: currentUrl.value,
      title: currentTitle.value,
      text: snapshot.element.text,
      selector: snapshot.element.selector || undefined,
      tag: snapshot.element.tag || undefined,
    });
  }
}

function requestAiOperate() {
  hidePageContextMenu();
  emit("aiOperateRequest");
}

defineExpose({
  captureAutomationSnapshot,
  captureArticleSnapshot,
  captureSearchResults,
  captureScreenshot,
  captureDiagnostics,
  runAutomationAction,
  getWebContentsId,
  getURL,
  isLoading,
  waitForReady,
  reload: reloadPage,
});

/** Guest webContents id of the embedded page, or null before it attaches. */
function getWebContentsId(): number | null {
  const webview = webviewRef.value;
  if (!webview || typeof webview.getWebContentsId !== "function") return null;
  try {
    return webview.getWebContentsId();
  } catch {
    return null;
  }
}

/** Current guest URL, or null before the webview attaches. */
function getURL(): string | null {
  const webview = webviewRef.value;
  if (!webview || typeof webview.getURL !== "function") return null;
  try {
    return webview.getURL() || null;
  } catch {
    return null;
  }
}

/** Whether the guest main frame is currently loading. */
function isLoading(): boolean {
  const webview = webviewRef.value;
  if (!webview || typeof webview.isLoading !== "function") return false;
  try {
    return Boolean(webview.isLoading());
  } catch {
    return false;
  }
}

/** Resolves once the guest is no longer loading (or rejects on timeout). */
async function waitForReady(timeoutMs = 15000): Promise<void> {
  const effectiveTimeout = Math.max(100, Math.min(Number(timeoutMs) || 15000, 25000));
  const deadline = Date.now() + effectiveTimeout;
  if (!webviewRef.value) {
    throw new Error("Browser readiness is unavailable before the page surface attaches.");
  }
  while (isLoading()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${effectiveTimeout}ms waiting for the page to become ready.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

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

  const handleDomReady = () => {
    void installDiagnosticsHooks();
  };

  const handleDidStartNavigation = (event: Event) => {
    const payload = event as Event & { isMainFrame?: boolean };
    if (payload.isMainFrame === false) return;
    diagnosticsNavigationId += 1;
    consoleBuffer.length = 0;
    pageErrorBuffer.length = 0;
  };

  const handleConsoleMessage = (event: Event) => {
    const payload = event as Event & {
      level?: number | string;
      message?: string;
      line?: number;
      sourceId?: string;
    };
    const level = String(payload.level ?? "info");
    const normalizedLevel: BrowserAutomationConsoleEntry["level"] =
      level === "error" || level === "3"
        ? "error"
        : level === "warning" || level === "warn" || level === "2"
          ? "warning"
          : level === "debug" || level === "0"
            ? "debug"
            : "info";
    consoleBuffer.push({
      level: normalizedLevel,
      message: String(payload.message ?? "").slice(0, 4000),
      source: payload.sourceId ? String(payload.sourceId).slice(0, 2000) : null,
      line: typeof payload.line === "number" ? payload.line : null,
      timestamp: Date.now(),
    });
    if (consoleBuffer.length > MAX_DIAGNOSTICS_ENTRIES) {
      consoleBuffer.splice(0, consoleBuffer.length - MAX_DIAGNOSTICS_ENTRIES);
    }
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

    if (payload.isMainFrame === false) return;
    if (Number(payload.errorCode) === -3) return;
    pageErrorBuffer.push({
      kind: "load",
      message: String(payload.errorDescription || `Page load failed (${payload.errorCode ?? "unknown"})`).slice(0, 4000),
      source: payload.validatedURL || currentUrl.value,
      timestamp: Date.now(),
    });
    if (pageErrorBuffer.length > MAX_DIAGNOSTICS_ENTRIES) {
      pageErrorBuffer.splice(0, pageErrorBuffer.length - MAX_DIAGNOSTICS_ENTRIES);
    }
  };

  const handleRenderProcessGone = (event: Event) => {
    const payload = event as Event & { details?: { reason?: string; exitCode?: number } };
    pageErrorBuffer.push({
      kind: "crash",
      message: `Renderer process exited (${payload.details?.reason || "unknown"}, code ${payload.details?.exitCode ?? "?"})`,
      timestamp: Date.now(),
    });
    if (pageErrorBuffer.length > MAX_DIAGNOSTICS_ENTRIES) {
      pageErrorBuffer.splice(0, pageErrorBuffer.length - MAX_DIAGNOSTICS_ENTRIES);
    }
  };

  webview.addEventListener(
    "page-title-updated",
    handleTitleUpdated as EventListener,
  );
  webview.addEventListener(
    "page-favicon-updated",
    handleFaviconUpdated as EventListener,
  );
  webview.addEventListener(
    "did-start-navigation",
    handleDidStartNavigation as EventListener,
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
  webview.addEventListener("dom-ready", handleDomReady as EventListener);
  webview.addEventListener("console-message", handleConsoleMessage as EventListener);
  webview.addEventListener("render-process-gone", handleRenderProcessGone as EventListener);

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
      "did-start-navigation",
      handleDidStartNavigation as EventListener,
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
    webview.removeEventListener("dom-ready", handleDomReady as EventListener);
    webview.removeEventListener("console-message", handleConsoleMessage as EventListener);
    webview.removeEventListener("render-process-gone", handleRenderProcessGone as EventListener);
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

function hideAllContextMenus() {
  hideAddressContextMenu();
  hidePageContextMenu();
}

onMounted(async () => {
  document.addEventListener("click", hideAllContextMenus);
  window.addEventListener("blur", hideAllContextMenus);
  browserPageContextMenuCleanup = window.electronAPI?.onBrowserPageContextMenu?.((payload) => {
    void handleBrowserPageContextMenu(payload);
  }) || null;
  await nextTick();
  detachListeners = attachWebviewListeners();
  emitStateChange();
});

onUnmounted(() => {
  document.removeEventListener("click", hideAllContextMenus);
  window.removeEventListener("blur", hideAllContextMenus);
  browserPageContextMenuCleanup?.();
  browserPageContextMenuCleanup = null;
  hideAddressContextMenu();
  hidePageContextMenu();
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
    <div class="browser-view-stage">
      <webview
        ref="webviewRef"
        class="browser-view-webview"
        :style="agentViewport ? { width: `${agentViewport.width}px`, height: `${agentViewport.height}px`, flex: '0 0 auto' } : undefined"
        :src="props.url"
        partition="persist:the-world-browser"
        allowpopups
        @contextmenu.stop
      ></webview>
    </div>
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
      <div
        v-if="pageContextMenu.visible"
        class="browser-page-context-menu"
        :style="{ left: `${pageContextMenu.x}px`, top: `${pageContextMenu.y}px`, minWidth: `${PAGE_CONTEXT_MENU_WIDTH}px` }"
        @mousedown.prevent.stop
        @click.stop
        @contextmenu.prevent
      >
        <button
          v-if="pageContextMenu.hasSelection"
          class="browser-address-context-action"
          type="button"
          @click.stop="copyPageSelection"
        >
          {{ pageContextMenu.copied ? t('chatUi.copied') : t('common.copy') }}
        </button>
        <button
          v-if="pageContextMenu.hasSelection"
          class="browser-address-context-action"
          type="button"
          @click.stop="addPageContentToContext"
        >
          {{ t('chatUi.addToContext') }}
        </button>
        <button
          v-else-if="pageContextMenu.hasElement"
          class="browser-address-context-action"
          type="button"
          @click.stop="addPageContentToContext"
        >
          {{ t('chatUi.addElementToContext') }}
        </button>
        <button
          v-if="pageContextMenu.hasLink"
          class="browser-address-context-action"
          type="button"
          @click.stop="copyPageLink"
        >
          {{ pageContextMenu.copied ? t('chatUi.copied') : t('chatUi.copyLink') }}
        </button>
        <div class="browser-page-context-divider"></div>
        <button class="browser-address-context-action" type="button" @click.stop="requestAiOperate">
          ✨ {{ t('chatUi.letAiOperatePage') }}
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

.browser-page-context-menu {
  position: fixed;
  z-index: 5000;
  min-width: 120px;
  padding: 4px;
  border: 1px solid rgba(148, 163, 184, 0.32);
  border-radius: 10px;
  background: #ffffff;
  box-shadow: 0 14px 36px rgba(15, 23, 42, 0.18);
}

.browser-page-context-divider {
  height: 1px;
  margin: 4px 8px;
  background: rgba(148, 163, 184, 0.28);
}

.browser-view-stage {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  overflow: auto;
}

.browser-view-webview {
  flex: 1;
  width: 100%;
  height: 100%;
  border: none;
}
</style>
