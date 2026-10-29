/** Pane-local event keeps terminal output and quotations out of other chats. */
export function appendCcDraft(source: HTMLElement, text: string) {
  source.closest("[data-cc-panel]")?.dispatchEvent(new CustomEvent("cc-append-draft", { detail: text }));
}
export function quoteCcText(text: string) { return text.split("\n").map(line => `> ${line}`).join("\n") + "\n\n"; }
