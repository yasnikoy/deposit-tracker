/** Whether a key press goes into a text field, where single-letter shortcuts must not fire. */
export function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** A plain letter or symbol key, without Ctrl, Alt or Meta. */
export const isPlainKey = (event: KeyboardEvent) => !event.ctrlKey && !event.metaKey && !event.altKey;
