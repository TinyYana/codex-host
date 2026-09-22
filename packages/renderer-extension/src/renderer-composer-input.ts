import { EDITOR_SELECTOR } from "./renderer-composer-dom.js";
import { prependRendererComposerText } from "./renderer-harness-command-claim.js";

const MAX_COMPOSER_INPUT_LENGTH = 200_000;

function editorText(editor: HTMLElement): string {
  const view = editor.ownerDocument.defaultView;
  if (view && editor instanceof view.HTMLTextAreaElement) return editor.value;
  return editor.innerText ?? editor.textContent ?? "";
}

/** The Composer's current plain text, or null when it is empty or unreasonably large. */
export function readRendererComposerInput(composer: Element): string | null {
  const editor = composer.querySelector<HTMLElement>(EDITOR_SELECTOR);
  if (!editor) return null;
  const text = editorText(editor);
  return text.trim() && text.length <= MAX_COMPOSER_INPUT_LENGTH ? text : null;
}

/**
 * Puts text into an empty Composer and focuses it. It never submits: sending stays an explicit
 * user action. A Composer that already holds a draft is left untouched.
 */
export function restoreRendererComposerInput(composer: Element, text: string): boolean {
  const editor = composer.querySelector<HTMLElement>(EDITOR_SELECTOR);
  if (!editor || !composer.isConnected || editorText(editor).trim()) return false;
  return prependRendererComposerText(editor, text);
}
