"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { matchesSearch } from "@/lib/search";
import { saveCustomerFilterAction } from "./actions";

type Customer = { id: number; name: string; code: string | null };

/** The customers this user follows; none selected means no filter. */
export function CustomerFilterForm({ customers, selected: initial }: { customers: Customer[]; selected: number[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<number>>(new Set(initial));
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const shown = customers.filter((c) => [c.name, c.code ?? ""].some((text) => matchesSearch(text, query)));

  const toggle = (id: number, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const save = async () => {
    setSaving(true);
    const result = await saveCustomerFilterAction({ customerIds: [...selected] });
    setSaving(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));
    toast.success(t("personalSettings.saved"));
    router.refresh();
  };

  if (customers.length === 0) return <p className="text-sm">{t("personalSettings.none")}</p>;
  return (
    <div className="flex flex-col gap-2">
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("personalSettings.search")} className="max-w-xs" />
      <ul className="flex max-h-72 flex-col gap-1 overflow-auto rounded-md border p-2">
        {shown.map((c) => (
          <li key={c.id}>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={selected.has(c.id)} onCheckedChange={(checked) => toggle(c.id, checked === true)} />
              {c.name}
              {c.code && <span className="text-muted-foreground text-xs">{c.code}</span>}
            </label>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground text-xs">
          {selected.size > 0 ? t("personalSettings.selected", { count: selected.size }) : t("personalSettings.all")}
        </span>
        {selected.size > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            {t("personalSettings.clear")}
          </Button>
        )}
        <Button type="button" size="sm" className="ml-auto" disabled={saving} onClick={save}>
          {t("personalSettings.save")}
        </Button>
      </div>
    </div>
  );
}
