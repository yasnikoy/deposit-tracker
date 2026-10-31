/**
 * Puts text on the clipboard. The app is served over plain HTTP on the office LAN, which is not a
 * secure context, so the Clipboard API is missing there; a hidden textarea and the copy command
 * work on any origin. Must be called from a user action (click or key press).
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Copy command was refused");
  } finally {
    area.remove();
  }
}
