export type EditorOccupancy =
  | { state: "empty"; normalizedText: "" }
  | { state: "visible-text"; normalizedText: string }
  | { state: "structured-content"; normalizedText: string }
  | { state: "unknown"; normalizedText: string }

const FORMAT_CHARACTER_PATTERN = /[\p{Cf}\u034F\uFE0E\uFE0F]/gu
const WHITESPACE_PATTERN = /\p{White_Space}+/gu
const OBJECT_REPLACEMENT_CHARACTER = "\uFFFC"

const STRUCTURED_CONTENT_SELECTOR = [
  "img",
  "video",
  "audio",
  "canvas",
  "svg",
  "iframe",
  "object",
  "embed",
  'input[type="file"]',
  '[contenteditable="false"]',
  '[data-lexical-decorator="true"]',
  '[data-slate-void="true"]',
  '[data-node-type="attachment"]',
  '[data-testid*="attachment" i]',
  '[data-testid*="file" i]',
  '[aria-label*="attachment" i]',
  '[aria-label*="file" i]',
].join(",")

const EMPTY_SAFE_TAGS = new Set([
  "BR",
  "P",
  "DIV",
  "SPAN",
  "B",
  "I",
  "EM",
  "STRONG",
  "U",
  "S",
  "CODE",
  "MARK",
  "SMALL",
  "SUB",
  "SUP",
  "PRE",
  "BLOCKQUOTE",
  "UL",
  "OL",
  "LI",
])

/**
 * 生成适合占用判断和正文比较的编辑器文本。
 * 保留可见内容，只删除格式控制字符并压缩 Unicode 空白。
 */
export function normalizeComparableEditorText(value: string | null | undefined): string {
  return (value || "")
    .normalize("NFKC")
    .replace(FORMAT_CHARACTER_PATTERN, "")
    .replace(WHITESPACE_PATTERN, " ")
    .trim()
}

function getEditorText(editor: HTMLElement): string {
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    return editor.value || ""
  }

  return editor.textContent || ""
}

function containsUnknownEmptyStructure(editor: HTMLElement): boolean {
  for (const element of Array.from(editor.querySelectorAll("*"))) {
    if (EMPTY_SAFE_TAGS.has(element.tagName)) continue
    if (element.getAttribute("aria-hidden") === "true") continue
    if (element.hasAttribute("data-placeholder")) continue
    return true
  }

  return false
}

/**
 * 判断原生输入框当前是否安全地视为空。
 * 对无法确定的结构采用保守策略，避免覆盖附件、引用块或站点自定义节点。
 */
export function getEditorOccupancy(editor: HTMLElement | null): EditorOccupancy {
  if (!editor || !editor.isConnected) {
    return { state: "unknown", normalizedText: "" }
  }

  const rawText = getEditorText(editor)
  const normalizedText = normalizeComparableEditorText(rawText)

  if (rawText.includes(OBJECT_REPLACEMENT_CHARACTER)) {
    return { state: "structured-content", normalizedText }
  }

  if (normalizedText) {
    return { state: "visible-text", normalizedText }
  }

  if (
    !(editor instanceof HTMLTextAreaElement) &&
    !(editor instanceof HTMLInputElement) &&
    editor.querySelector(STRUCTURED_CONTENT_SELECTOR)
  ) {
    return { state: "structured-content", normalizedText: "" }
  }

  if (
    !(editor instanceof HTMLTextAreaElement) &&
    !(editor instanceof HTMLInputElement) &&
    containsUnknownEmptyStructure(editor)
  ) {
    return { state: "unknown", normalizedText: "" }
  }

  return { state: "empty", normalizedText: "" }
}
