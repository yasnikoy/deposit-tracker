"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isTranslationKey, t } from "@/i18n";
import { bankAccountInputSchema, currencyInputSchema } from "@/lib/schemas/lists";
import type { ActionResult } from "@/server/errors";
import type { BankAccount, Currency } from "@/server/lists";
import { saveBankAccountAction, saveCurrencyAction } from "./actions";

type Editing = { kind: "currency"; currency: Currency | null } | { kind: "account"; account: BankAccount | null } | null;

export function ListsScreen({ currencies, bankAccounts }: { currencies: Currency[]; bankAccounts: BankAccount[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<Editing>(null);
  const done = (result: ActionResult<unknown>) => {
    if (!result.ok) return false;
    toast.success(t("lists.toast.saved"));
    setEditing(null);
    router.refresh();
    return true;
  };

  return (
    <div className="grid max-w-5xl grid-cols-[20rem_1fr] items-start gap-4">
      <Card>
        <CardHeader className="flex flex-row items-center">
          <CardTitle>{t("lists.currencies")}</CardTitle>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setEditing({ kind: "currency", currency: null })}>
            <Plus /> {t("lists.addCurrency")}
          </Button>
        </CardHeader>
        <CardContent>
          <table className="w-full">
            <tbody>
              {currencies.map((c) => (
                <tr key={c.code} className="hover:bg-muted cursor-pointer border-t" onClick={() => setEditing({ kind: "currency", currency: c })}>
                  <td className="py-1 font-mono">{c.code}</td>
                  <td className="py-1">{c.name}</td>
                  <td className="text-muted-foreground py-1 text-right text-xs">{c.active ? t("lists.active") : t("lists.inactive")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center">
          <CardTitle>{t("lists.bankAccounts")}</CardTitle>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setEditing({ kind: "account", account: null })}>
            <Plus /> {t("lists.addBankAccount")}
          </Button>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground mb-2 text-xs">{t("lists.bankAccountsHint")}</p>
          <table className="w-full">
            <thead className="text-left">
              <tr>
                <th className="py-1 font-medium">{t("lists.accountName")}</th>
                <th className="py-1 font-medium">{t("lists.bankName")}</th>
                <th className="py-1 font-medium">{t("lists.iban")}</th>
                <th className="py-1 font-medium">{t("lists.currency")}</th>
                <th className="py-1 font-medium">{t("lists.status")}</th>
              </tr>
            </thead>
            <tbody>
              {bankAccounts.map((a) => (
                <tr key={a.id} className="hover:bg-muted cursor-pointer border-t" onClick={() => setEditing({ kind: "account", account: a })}>
                  <td className="py-1">{a.name}</td>
                  <td className="py-1">{a.bankName}</td>
                  <td className="py-1 font-mono text-xs">{a.iban}</td>
                  <td className="py-1">{a.currency}</td>
                  <td className="text-muted-foreground py-1 text-xs">{a.active ? t("lists.active") : t("lists.inactive")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {editing?.kind === "currency" && <CurrencyDialog currency={editing.currency} onCancel={() => setEditing(null)} onDone={done} />}
      {editing?.kind === "account" && (
        <BankAccountDialog account={editing.account} currencies={currencies} onCancel={() => setEditing(null)} onDone={done} />
      )}
    </div>
  );
}

function errorText(key: string | undefined) {
  return key ? (isTranslationKey(key) ? t(key) : t("errors.validation")) : null;
}

function CurrencyDialog({
  currency,
  onCancel,
  onDone,
}: {
  currency: Currency | null;
  onCancel: () => void;
  onDone: (result: ActionResult<unknown>) => boolean;
}) {
  const [values, setValues] = useState({ code: currency?.code ?? "", name: currency?.name ?? "", active: currency?.active ?? true });
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const input = { ...values, reason: "" };
    const parsed = currencyInputSchema.safeParse(input);
    if (!parsed.success) return setError(errorText(parsed.error.issues[0]?.message));
    const result = await saveCurrencyAction(input);
    if (!onDone(result) && !result.ok) setError(t(result.error, result.params));
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{currency ? currency.code : t("lists.addCurrency")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="currency-code">{t("lists.currencyCode")}</Label>
            <Input id="currency-code" value={values.code} disabled={currency !== null} onChange={(e) => setValues({ ...values, code: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="currency-name">{t("lists.currencyName")}</Label>
            <Input id="currency-name" value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} />
          </div>
          <label className="flex items-center gap-2">
            <Checkbox checked={values.active} onCheckedChange={(c) => setValues({ ...values, active: c === true })} />
            {t("lists.active")}
          </label>
          {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save}>{t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BankAccountDialog({
  account,
  currencies,
  onCancel,
  onDone,
}: {
  account: BankAccount | null;
  currencies: Currency[];
  onCancel: () => void;
  onDone: (result: ActionResult<unknown>) => boolean;
}) {
  const [values, setValues] = useState({
    name: account?.name ?? "",
    bankName: account?.bankName ?? "",
    iban: account?.iban ?? "",
    currency: account?.currency ?? currencies.find((c) => c.active)?.code ?? "",
    active: account?.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const input = { ...values, id: account?.id, reason: "" };
    const parsed = bankAccountInputSchema.safeParse(input);
    if (!parsed.success) return setError(errorText(parsed.error.issues[0]?.message));
    const result = await saveBankAccountAction(input);
    if (!onDone(result) && !result.ok) setError(t(result.error, result.params));
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{account ? account.name : t("lists.addBankAccount")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {(
            [
              ["name", "lists.accountName"],
              ["bankName", "lists.bankName"],
              ["iban", "lists.iban"],
            ] as const
          ).map(([field, label]) => (
            <div key={field} className="flex flex-col gap-1.5">
              <Label htmlFor={`account-${field}`}>{t(label)}</Label>
              <Input
                id={`account-${field}`}
                className={field === "iban" ? "font-mono" : undefined}
                value={values[field]}
                onChange={(e) => setValues({ ...values, [field]: e.target.value })}
              />
            </div>
          ))}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-currency">{t("lists.currency")}</Label>
            <select
              id="account-currency"
              className="border-input bg-background h-9 rounded-md border px-2"
              value={values.currency}
              onChange={(e) => setValues({ ...values, currency: e.target.value })}
            >
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2">
            <Checkbox checked={values.active} onCheckedChange={(c) => setValues({ ...values, active: c === true })} />
            {t("lists.active")}
          </label>
          {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save}>{t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
