"use client";

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { matchesSearch } from "@/lib/search";
import { cn } from "@/lib/utils";

export type AgencyOption = { id: number; name: string; bankSenderAliases: string[]; blNumberPatterns: string[]; active: boolean };

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase("tr-TR") === b.trim().toLocaleLowerCase("tr-TR");

type Option = { kind: "agency"; agency: AgencyOption } | { kind: "new"; name: string };

/**
 * Agency picker searchable by name and by the sender names the bank prints on receipts.
 * With `onNewName`, a typed name that matches no agency can be chosen as a new agency.
 */
export function AgencyCombobox({
  id,
  agencies,
  value,
  onChange,
  newName = null,
  onNewName,
  placeholder,
  invalid,
}: {
  id?: string;
  agencies: AgencyOption[];
  value: number | null;
  onChange: (agencyId: number | null) => void;
  newName?: string | null;
  onNewName?: (name: string | null) => void;
  placeholder: string;
  invalid?: boolean;
}) {
  const listId = useId();
  const selected = agencies.find((a) => a.id === value) ?? null;
  const [query, setQuery] = useState(selected?.name ?? newName ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const options = useMemo((): Option[] => {
    const matches: Option[] = agencies
      .filter((a) => (a.active || a.id === value) && [a.name, ...a.bankSenderAliases].some((text) => matchesSearch(text, query)))
      .map((agency) => ({ kind: "agency", agency }));
    const name = query.trim();
    const offerNew = onNewName && name !== "" && !agencies.some((a) => sameName(a.name, name));
    return offerNew ? [...matches, { kind: "new", name }] : matches;
  }, [agencies, query, value, onNewName]);

  const choose = (option: Option) => {
    if (option.kind === "agency") {
      onNewName?.(null);
      onChange(option.agency.id);
      setQuery(option.agency.name);
    } else {
      onChange(null);
      onNewName?.(option.name);
      setQuery(option.name);
    }
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") setActive((i) => Math.min(options.length - 1, i + 1));
    else if (event.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
    else if (event.key === "Enter" && open && options[active]) choose(options[active]);
    else if (event.key === "Escape" && open) setOpen(false);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-invalid={invalid}
        autoComplete="off"
        value={query}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
          if (selected && event.target.value !== selected.name) onChange(null);
          if (newName !== null && event.target.value.trim() !== newName) onNewName?.(null);
        }}
        onKeyDown={onKeyDown}
      />
      {open && options.length > 0 && (
        <ul id={listId} role="listbox" className="bg-popover absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-md border shadow-md">
          {options.map((option, index) => (
            <li
              key={option.kind === "agency" ? option.agency.id : "new"}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(option);
              }}
              className={cn("cursor-pointer px-2 py-1", index === active && "bg-muted")}
            >
              {option.kind === "agency" ? (
                <>
                  <div>{option.agency.name}</div>
                  {option.agency.bankSenderAliases.length > 0 && (
                    <div className="text-muted-foreground text-xs">{option.agency.bankSenderAliases.join(" · ")}</div>
                  )}
                </>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Plus className="size-4" />
                  {t("agencies.addNew", { name: option.name })}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
