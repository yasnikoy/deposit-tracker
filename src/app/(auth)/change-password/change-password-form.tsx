"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { FieldMessage } from "@/components/field-message";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t, type TranslationKey } from "@/i18n";
import { changePasswordSchema } from "@/lib/schemas/users";
import { changePasswordAction, logoutAction } from "../actions";

type Values = z.input<ReturnType<typeof changePasswordSchema>>;
const FIELDS = [
  { name: "currentPassword", label: "auth.changePassword.current", autoComplete: "current-password" },
  { name: "newPassword", label: "auth.changePassword.new", autoComplete: "new-password" },
  { name: "confirmPassword", label: "auth.changePassword.confirm", autoComplete: "new-password" },
] as const;

export function ChangePasswordForm({ forced, minLength }: { forced: boolean; minLength: number }) {
  const router = useRouter();
  const [error, setError] = useState<TranslationKey | null>(null);
  const schema = useMemo(() => changePasswordSchema(minLength), [minLength]);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const result = await changePasswordAction(values);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.success(t("auth.changePassword.success"));
    router.replace("/");
    router.refresh();
  });

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{t("auth.changePassword.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {forced && (
            <Alert>
              <AlertDescription>{t("auth.changePassword.forcedNotice")}</AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{t(error, { min: minLength })}</AlertDescription>
            </Alert>
          )}
          {FIELDS.map((field, index) => (
            <div key={field.name} className="flex flex-col gap-1.5">
              <Label htmlFor={field.name}>{t(field.label)}</Label>
              <Input
                id={field.name}
                type="password"
                autoComplete={field.autoComplete}
                autoFocus={index === 0}
                {...form.register(field.name)}
              />
              <FieldMessage message={errors[field.name]?.message} params={{ min: minLength }} />
            </div>
          ))}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t("common.loading") : t("auth.changePassword.submit")}
          </Button>
          {forced ? (
            <Button type="button" variant="ghost" onClick={() => logoutAction()}>
              {t("nav.logout")}
            </Button>
          ) : (
            <Button asChild variant="ghost">
              <Link href="/">{t("common.cancel")}</Link>
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
