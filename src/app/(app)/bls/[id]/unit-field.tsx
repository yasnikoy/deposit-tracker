"use client";

import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { setBlUnitAction } from "../actions";

/** The agency unit the B/L's requests go to, changed in place (operations, audited); later requests follow it. */
export function UnitField({
  blId,
  unitId,
  unitName,
  units,
  editable,
}: {
  blId: number;
  unitId: number | null;
  unitName: string | null;
  /** The agency's active units. */
  units: { id: number; name: string }[];
  editable: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<number | null>(unitId);
  const [busy, setBusy] = useState(false);
  // A unit deactivated since, while the agency still has active ones, no longer routes requests.
  const missing = units.length > 0 && !units.some((u) => u.id === unitId);

  const save = async () => {
    if (value === null) return;
    setBusy(true);
    const result = await setBlUnitAction({ blId, unitId: value });
    setBusy(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));
    toast.success(t("bls.unitSaved"));
    setEditing(false);
    router.refresh();
  };

  if (!editing) {
    return (
      <span className="flex items-center gap-2">
        {unitName ?? <span className="text-muted-foreground">{t("common.none")}</span>}
        {missing && <Badge variant="warning">{t("bls.unitMissing")}</Badge>}
        {editable && units.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5"
            aria-label={t("bls.unitEdit")}
            title={t("bls.unitEdit")}
            onClick={() => {
              setValue(missing ? null : unitId);
              setEditing(true);
            }}
          >
            <Pencil className="size-3.5" />
          </Button>
        )}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <select
        aria-label={t("bls.unit")}
        className="border-input bg-background h-8 rounded-md border px-2"
        value={value ?? ""}
        onChange={(event) => setValue(event.target.value ? Number(event.target.value) : null)}
        autoFocus
      >
        <option value="">{t("bls.unitPick")}</option>
        {units.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
      <Button type="button" size="sm" disabled={busy || value === null || value === unitId} onClick={save}>
        {t("common.save")}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
        {t("common.cancel")}
      </Button>
    </span>
  );
}
