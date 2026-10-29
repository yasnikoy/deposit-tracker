"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";

/** Previous/next through the rows the list showed when the record was opened (its sort and filters). */
export type DetailNavigation = { index: number; count: number; onPrevious: () => void; onNext: () => void };

/** Moves through a list of ids; null when the open record is not (or no longer) in it. */
export function detailNavigation(ids: readonly string[], openId: string | null, open: (id: string) => void): DetailNavigation | null {
  const index = openId === null ? -1 : ids.indexOf(openId);
  if (index < 0) return null;
  return {
    index,
    count: ids.length,
    onPrevious: () => index > 0 && open(ids[index - 1]),
    onNext: () => index < ids.length - 1 && open(ids[index + 1]),
  };
}

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * The details of one list row in a large centered dialog over the list, which keeps its full
 * width. Esc or the close button closes it; ← / → (outside form fields) or the buttons move
 * to the previous or next row.
 */
export function DetailDialog({
  title,
  description,
  navigation,
  onClose,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  navigation?: DetailNavigation | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const hasPrevious = !!navigation && navigation.index > 0;
  const hasNext = !!navigation && navigation.index < navigation.count - 1;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-h-[88vh] flex-col gap-0 p-0 sm:max-w-5xl"
        onKeyDown={(event) => {
          if (!navigation || event.defaultPrevented || isEditable(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;
          if (event.key === "ArrowLeft" && hasPrevious) navigation.onPrevious();
          else if (event.key === "ArrowRight" && hasNext) navigation.onNext();
          else return;
          event.preventDefault();
        }}
      >
        <DialogHeader className="border-b px-5 py-3 pr-12">
          <DialogTitle className="truncate">{title}</DialogTitle>
          <DialogDescription className={description ? undefined : "sr-only"}>{description ?? t("detailDialog.description")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
        {navigation && navigation.count > 1 && (
          <footer className="flex items-center gap-2 border-t px-5 py-2">
            <Button variant="outline" size="sm" onClick={navigation.onPrevious} disabled={!hasPrevious}>
              <ChevronLeft /> {t("detailDialog.previous")}
            </Button>
            <span className="text-muted-foreground text-sm tabular-nums">{t("detailDialog.position", { index: navigation.index + 1, count: navigation.count })}</span>
            <Button variant="outline" size="sm" onClick={navigation.onNext} disabled={!hasNext}>
              {t("detailDialog.next")} <ChevronRight />
            </Button>
            <span className="text-muted-foreground ml-auto text-xs">{t("detailDialog.keys")}</span>
          </footer>
        )}
      </DialogContent>
    </Dialog>
  );
}
