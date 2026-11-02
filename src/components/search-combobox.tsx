"use client";

import { Plus } from "lucide-react";
import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { matchesSearch } from "@/lib/search";
import { cn } from "@/lib/utils";

export type ComboboxItem = { id: number; name: string; active: boolean };

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase("tr-TR") === b.trim().toLocaleLowerCase("tr-TR");

type Option<T> = { kind: "item"; item: T } | { kind: "new"; name: string };

/**
 * Picker over named records, searchable by name and further texts (e.g. aliases). With
 * `onNewName`, a typed name that matches no record can be chosen as a new one. A value set
 * from outside (prefill, carried over from the last record) shows its name.
 */
export function SearchCombobox<T extends ComboboxItem>({
  id,
  items,
  value,
  onChange,
  newName = null,
  onNewName,
  newLabel,
  searchTexts = () => [],
  hint,
  placeholder,
  invalid,
  disabled,
}: {
  id?: string;
  items: T[];
  value: number | null;
  onChange: (id: number | null) => void;
  newName?: string | null;
  onNewName?: (name: string | null) => void;
  newLabel?: (name: string) => string;
  searchTexts?: (item: T) => string[];
  hint?: (item: T) => ReactNode;
  placeholder: string;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const listId = useId();
  const selected = items.find((a) => a.id === value) ?? null;
  const [query, setQuery] = useState(selected?.name ?? newName ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  // Follow a value or new name set from outside; typing clears them, which leaves the text as typed.
  const [shown, setShown] = useState({ value, newName });
  if (shown.value !== value || shown.newName !== newName) {
    setShown({ value, newName });
    if (selected && query !== selected.name) setQuery(selected.name);
    else if (!selected && newName !== null && query.trim() !== newName) setQuery(newName);
  }

  const options = useMemo((): Option<T>[] => {
    const matches: Option<T>[] = items
      .filter((a) => (a.active || a.id === value) && [a.name, ...searchTexts(a)].some((text) => matchesSearch(text, query)))
      .map((item) => ({ kind: "item", item }));
    const name = query.trim();
    const offerNew = onNewName && name !== "" && !items.some((a) => sameName(a.name, name));
    return offerNew ? [...matches, { kind: "new", name }] : matches;
  }, [items, query, value, onNewName, searchTexts]);

  const choose = (option: Option<T>) => {
    if (option.kind === "item") {
      onNewName?.(null);
      onChange(option.item.id);
      setQuery(option.item.name);
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
        disabled={disabled}
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
              key={option.kind === "item" ? option.item.id : "new"}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(option);
              }}
              className={cn("cursor-pointer px-2 py-1", index === active && "bg-muted")}
            >
              {option.kind === "item" ? (
                <>
                  <div>{option.item.name}</div>
                  {hint?.(option.item)}
                </>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Plus className="size-4" />
                  {newLabel ? newLabel(option.name) : option.name}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
