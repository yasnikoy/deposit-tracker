"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { FieldMessage } from "@/components/field-message";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t, type TranslationKey } from "@/i18n";
import { loginSchema } from "@/lib/schemas/users";
import { loginAction } from "../actions";

type Values = z.input<typeof loginSchema>;

export function LoginForm() {
  const [error, setError] = useState<TranslationKey | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(loginSchema), defaultValues: { username: "", password: "" } });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const result = await loginAction(values);
    if (!result.ok) {
      setError(result.error);
      form.resetField("password");
      form.setFocus("password");
    }
  });

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{t("auth.login.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{t(error)}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="username">{t("auth.login.username")}</Label>
            <Input id="username" autoComplete="username" autoFocus {...form.register("username")} />
            <FieldMessage message={errors.username?.message} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">{t("auth.login.password")}</Label>
            <Input id="password" type="password" autoComplete="current-password" {...form.register("password")} />
            <FieldMessage message={errors.password?.message} />
          </div>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t("common.loading") : t("auth.login.submit")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
