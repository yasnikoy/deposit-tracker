"use client";

import { useRouter } from "next/navigation";
import { useForm, useWatch, type FieldErrors, type Resolver } from "react-hook-form";
import { toast } from "sonner";
import type { CustomerOption } from "@/components/customer-combobox";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isTranslationKey, t } from "@/i18n";
import { customerInputSchema } from "@/lib/schemas/customers";
import { createCustomerAction, updateCustomerAction } from "./customer-actions";

type FormValues = { name: string; code: string; aliasesText: string; active: boolean };

// Aliases are entered one per line, so they can be pasted from Excel.
const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

const toInput = (values: FormValues) => ({ name: values.name, code: values.code, aliases: lines(values.aliasesText), active: values.active });

const resolver: Resolver<FormValues> = async (values) => {
  const parsed = customerInputSchema.safeParse(toInput(values));
  if (parsed.success) return { values, errors: {} };
  const errors: FieldErrors<FormValues> = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0]);
    const field = (key === "aliases" ? "aliasesText" : key) as keyof FormValues;
    if (!errors[field]) errors[field] = { type: "validation", message: isTranslationKey(issue.message) ? t(issue.message) : t("errors.validation") };
  }
  return { values: {}, errors };
};

function FieldError({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="text-destructive text-xs">
      {message}
    </p>
  ) : null;
}

export function CustomerForm({ customer, readOnly, onCreated }: { customer: CustomerOption | null; readOnly: boolean; onCreated: (id: number) => void }) {
  const router = useRouter();
  const form = useForm<FormValues>({
    resolver,
    defaultValues: { name: customer?.name ?? "", code: customer?.code ?? "", aliasesText: customer?.aliases.join("\n") ?? "", active: customer?.active ?? true },
  });
  const { errors, isSubmitting } = form.formState;
  const active = useWatch({ control: form.control, name: "active" });

  const onSubmit = form.handleSubmit(async (values) => {
    if (customer) {
      const result = await updateCustomerAction({ id: customer.id, customer: toInput(values) });
      if (!result.ok) return void toast.error(t(result.error, result.params));
      toast.success(t("customers.toast.updated"));
      form.reset(values);
    } else {
      const result = await createCustomerAction(toInput(values));
      if (!result.ok) return void toast.error(t(result.error, result.params));
      toast.success(t("customers.toast.created"));
      onCreated(result.data);
    }
    router.refresh();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      {readOnly && <p className="text-muted-foreground text-xs">{t("customers.readOnly")}</p>}
      <fieldset disabled={readOnly || isSubmitting} className="flex flex-col gap-4">
        <div className="flex items-end gap-4">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="customer-name">{t("customers.name")}</Label>
            <Input id="customer-name" autoFocus={!customer} {...form.register("name")} />
            <FieldError message={errors.name?.message} />
          </div>
          {customer && (
            <label className="flex items-center gap-2 pb-2">
              <Checkbox checked={active} onCheckedChange={(checked) => form.setValue("active", checked === true, { shouldDirty: true })} disabled={readOnly} />
              {t("agencies.active")}
            </label>
          )}
        </div>
        <div className="flex w-48 flex-col gap-1.5">
          <Label htmlFor="customer-code">{t("customers.code")}</Label>
          <Input id="customer-code" {...form.register("code")} />
          <FieldError message={errors.code?.message} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="customer-aliases">{t("customers.aliases")}</Label>
          <textarea id="customer-aliases" rows={3} className="border-input bg-background rounded-md border px-2 py-1 font-mono text-xs disabled:opacity-60" {...form.register("aliasesText")} />
          <p className="text-muted-foreground text-xs">{t("customers.aliasesHint")}</p>
          <FieldError message={errors.aliasesText?.message} />
        </div>
        {!readOnly && (
          <div className="flex justify-end">
            <Button type="submit">{t("common.save")}</Button>
          </div>
        )}
      </fieldset>
    </form>
  );
}
