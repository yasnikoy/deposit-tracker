"use client";

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { matchesSearch } from "@/lib/search";
import { cn } from "@/lib/utils";

export type AgencyOption = { id: number; name: string; bankSenderAliases: string[]; blNumberPatterns: string[]; active: boolean };

/** Agency picker searchable by name and by the sender names the bank prints on receipts. */
export function AgencyCombobox({
  id,
  agencies,
  value,
  onChange,
  placeholder,
  invalid,
}: {
  id?: string;
  agencies: AgencyOption[];
  value: number | null;
  onChange: (agencyId: number | null) => void;
  placeholder: string;
  invalid?: boolean;
}) {
  const listId = useId();
  const selected = agencies.find((a) => a.id === value) ?? null;
  const [query, setQuery] = useState(selected?.name ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const options = useMemo(
    () =>
      agencies.filter(
        (a) => (a.active || a.id === value) && [a.name, ...a.bankSenderAliases].some((text) => matchesSearch(text, query)),
      ),
    [agencies, query, value],
  );

  const choose = (option: AgencyOption) => {
    onChange(option.id);
    setQuery(option.name);
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
        }}
        onKeyDown={onKeyDown}
      />
      {open && options.length > 0 && (
        <ul id={listId} role="listbox" className="bg-popover absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-md border shadow-md">
          {options.map((option, index) => (
            <li
              key={option.id}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(option);
              }}
              className={cn("cursor-pointer px-2 py-1", index === active && "bg-muted")}
            >
              <div>{option.name}</div>
              {option.bankSenderAliases.length > 0 && (
                <div className="text-muted-foreground text-xs">{option.bankSenderAliases.join(" · ")}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
