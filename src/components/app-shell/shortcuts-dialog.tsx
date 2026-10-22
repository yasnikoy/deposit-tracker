"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t, type TranslationKey } from "@/i18n";

const SHORTCUTS: { keys: string[]; label: TranslationKey }[] = [
  { keys: ["↑", "↓", "Home", "End"], label: "shortcuts.moveRows" },
  { keys: ["Enter"], label: "shortcuts.openRow" },
  { keys: ["Space"], label: "shortcuts.toggleRow" },
  { keys: ["Esc"], label: "shortcuts.closePanel" },
  { keys: ["?"], label: "shortcuts.showHelp" },
];

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** "?" anywhere outside a text field shows the shortcut list. */
export function ShortcutsDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "?" && !event.ctrlKey && !event.metaKey && !isTyping(event.target)) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("shortcuts.title")}</DialogTitle>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.label} className="contents">
              <dt className="flex gap-1">
                {shortcut.keys.map((key) => (
                  <kbd key={key} className="bg-muted rounded border px-1.5 py-0.5 font-mono text-xs">
                    {key}
                  </kbd>
                ))}
              </dt>
              <dd>{t(shortcut.label)}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
