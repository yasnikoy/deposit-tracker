"use client";

import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/**
 * Wide, non-modal panel on the right of a list. Esc closes it unless a dialog
 * or menu is open (those handle Esc themselves).
 */
export function DetailPanel({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("[role=dialog], [role=menu]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <aside
      aria-label={typeof title === "string" ? title : undefined}
      className="bg-background sticky top-[3.75rem] flex max-h-[calc(100vh-4.75rem)] w-[36rem] shrink-0 flex-col rounded-md border"
    >
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <h2 className="truncate font-semibold">{title}</h2>
        <Button variant="ghost" size="icon" className="ml-auto size-7" onClick={onClose} aria-label={t("detailPanel.close")}>
          <X />
        </Button>
      </header>
      <div className="flex-1 overflow-auto p-4">{children}</div>
    </aside>
  );
}
