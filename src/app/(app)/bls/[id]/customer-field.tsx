"use client";

import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { CustomerCombobox, type CustomerOption } from "@/components/customer-combobox";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { setBlCustomerAction } from "../actions";

/** The B/L's customer, changed in place (audited); it drives the customer filter and refund matching. */
export function CustomerField({
  blId,
  customerId,
  customerName,
  customers,
  editable,
}: {
  blId: number;
  customerId: number | null;
  customerName: string | null;
  customers: CustomerOption[];
  editable: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<number | null>(customerId);
  const [busy, setBusy] = useState(false);

  const save = async (next: number | null) => {
    setBusy(true);
    const result = await setBlCustomerAction({ blId, customerId: next });
    setBusy(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));
    toast.success(t("bls.customerSaved"));
    setEditing(false);
    router.refresh();
  };

  if (!editing) {
    return (
      <span className="flex items-center gap-2">
        {customerName ?? <span className="text-muted-foreground">{t("bls.customerNone")}</span>}
        {editable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5"
            aria-label={t("bls.customerEdit")}
            title={t("bls.customerEdit")}
            onClick={() => {
              setValue(customerId);
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
      <span className="w-64">
        <CustomerCombobox id={`bl-${blId}-customer`} customers={customers} value={value} onChange={setValue} placeholder={t("refunds.customerSearch")} />
      </span>
      <Button type="button" size="sm" disabled={busy || value === null || value === customerId} onClick={() => save(value)}>
        {t("common.save")}
      </Button>
      {customerId !== null && (
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => save(null)}>
          {t("bls.customerClear")}
        </Button>
      )}
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
        {t("common.cancel")}
      </Button>
    </span>
  );
}
