"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { searchBlsAction } from "@/app/(app)/bls/actions";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { BlSearchResult } from "@/server/bl-overview";
import { BlStatusBadge } from "../bl-status-badge";

const DEBOUNCE_MS = 200;

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * Header search over B/L and container numbers, agency names and amounts.
 * "/" or Ctrl+K focuses it; pasting several numbers lists every match; Enter opens the B/L.
 */
export function GlobalSearch() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<BlSearchResult | null>(null);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const ctrlK = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
      if (ctrlK || (event.key === "/" && !isTyping(event.target))) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (query.trim() === "") return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const response = await searchBlsAction({ query });
      if (cancelled) return;
      setResult(response.ok ? response.data : null);
      setActive(0);
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const items = query.trim() === "" ? [] : (result?.items ?? []);
  const go = (id: number) => {
    setOpen(false);
    inputRef.current?.blur();
    router.push(`/bls/${id}`);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") setActive((i) => Math.min(items.length - 1, i + 1));
    else if (event.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
    else if (event.key === "Enter" && items[active]) go(items[active].id);
    else if (event.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    } else return;
    event.preventDefault();
  };

  return (
    <div className="relative w-96">
      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
      <Input
        ref={inputRef}
        role="combobox"
        aria-expanded={open && query.trim() !== ""}
        aria-controls="global-search-results"
        aria-label={t("search.label")}
        placeholder={t("search.placeholder")}
        className="h-8 pl-8"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      {open && query.trim() !== "" && result && (
        <div
          id="global-search-results"
          className="bg-popover text-popover-foreground absolute top-full right-0 left-0 z-30 mt-1 max-h-[70vh] overflow-auto rounded-md border shadow-md"
        >
          {items.length === 0 && <p className="text-muted-foreground px-3 py-2">{t("search.noResults")}</p>}
          <ul role="listbox" aria-label={t("search.label")}>
            {items.map((item, index) => (
              <li
                key={item.id}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => go(item.id)}
                onMouseEnter={() => setActive(index)}
                className={cn("flex cursor-pointer flex-col gap-0.5 px-3 py-1.5", index === active && "bg-accent")}
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono font-medium">{item.blNo}</span>
                  <BlStatusBadge status={item.status} />
                  <span className="tabular ml-auto whitespace-nowrap">{formatMoney(item.depositMinor, item.currency)}</span>
                </span>
                <span className="text-muted-foreground truncate text-xs">
                  {item.agencyName}
                  {item.containers.length > 0 && ` · ${item.containers.join(", ")}`}
                  {" · "}
                  {item.matched.map((field) => t(`search.matched.${field}`)).join(", ")}
                </span>
              </li>
            ))}
          </ul>
          {result.notFound.length > 0 && (
            <p className="border-t px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              {t("search.notFound", { list: result.notFound.join(", ") })}
            </p>
          )}
          {result.truncated && <p className="text-muted-foreground border-t px-3 py-2 text-xs">{t("search.truncated", { count: items.length })}</p>}
        </div>
      )}
    </div>
  );
}
