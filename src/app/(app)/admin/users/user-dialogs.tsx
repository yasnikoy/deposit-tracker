"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { FieldMessage } from "@/components/field-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ROLES, type Role } from "@/domain/roles";
import { t, type TranslationKey } from "@/i18n";
import {
  displayNameSchema,
  passwordSchema,
  rolesSchema,
  usernameSchema,
} from "@/lib/schemas/users";
import type { ActionResult } from "@/server/errors";
import type { UserListItem } from "@/server/users";
import { createUserAction, resetUserPasswordAction, updateUserAction } from "./actions";

type FormValues = { username: string; displayName: string; roles: Role[]; temporaryPassword: string };

/** Create (user = null) or edit a user. Username is fixed after creation. */
export function UserFormDialog({
  user,
  minPasswordLength,
  onDone,
  onCancel,
}: {
  user: UserListItem | null;
  minPasswordLength: number;
  onDone: (result: ActionResult<unknown>, success: TranslationKey) => void;
  onCancel: () => void;
}) {
  const creating = user === null;
  const schema = useMemo(
    () =>
      z.object({
        username: creating ? usernameSchema : z.string(),
        displayName: displayNameSchema,
        roles: rolesSchema,
        temporaryPassword: creating ? passwordSchema(minPasswordLength) : z.string(),
      }),
    [creating, minPasswordLength],
  );
  const form = useForm<FormValues>({
    resolver: zodResolver(schema) as never,
    defaultValues: {
      username: user?.username ?? "",
      displayName: user?.displayName ?? "",
      roles: user?.roles ?? [],
      temporaryPassword: "",
    },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    if (creating) {
      onDone(await createUserAction(values), "users.toast.created");
    } else {
      onDone(
        await updateUserAction({ userId: user.id, displayName: values.displayName, roles: values.roles }),
        "users.toast.updated",
      );
    }
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{creating ? t("users.new") : t("users.edit")}</DialogTitle>
          {creating && <DialogDescription>{t("users.temporaryPasswordHint")}</DialogDescription>}
        </DialogHeader>
        <form id="user-form" onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="username">{t("users.username")}</Label>
            <Input id="username" autoComplete="off" disabled={!creating} autoFocus={creating} {...form.register("username")} />
            <FieldMessage message={errors.username?.message} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="displayName">{t("users.displayName")}</Label>
            <Input id="displayName" autoComplete="off" autoFocus={!creating} {...form.register("displayName")} />
            <FieldMessage message={errors.displayName?.message} />
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">{t("users.roles")}</legend>
            <Controller
              control={form.control}
              name="roles"
              render={({ field }) => (
                <div className="flex gap-4">
                  {ROLES.map((role) => (
                    <label key={role} className="flex items-center gap-2">
                      <Checkbox
                        checked={field.value.includes(role)}
                        onCheckedChange={(checked) =>
                          field.onChange(checked ? [...field.value, role] : field.value.filter((r) => r !== role))
                        }
                      />
                      {t(`roles.${role}`)}
                    </label>
                  ))}
                </div>
              )}
            />
            <FieldMessage message={errors.roles?.message} />
          </fieldset>
          {creating && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="temporaryPassword">{t("users.temporaryPassword")}</Label>
              <Input id="temporaryPassword" type="text" autoComplete="off" {...form.register("temporaryPassword")} />
              <FieldMessage message={errors.temporaryPassword?.message} params={{ min: minPasswordLength }} />
            </div>
          )}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={isSubmitting}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="user-form" disabled={isSubmitting}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ResetPasswordDialog({
  user,
  minPasswordLength,
  onDone,
  onCancel,
}: {
  user: UserListItem;
  minPasswordLength: number;
  onDone: (result: ActionResult<unknown>) => void;
  onCancel: () => void;
}) {
  const schema = useMemo(() => z.object({ temporaryPassword: passwordSchema(minPasswordLength) }), [minPasswordLength]);
  const form = useForm<{ temporaryPassword: string }>({
    resolver: zodResolver(schema),
    defaultValues: { temporaryPassword: "" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) =>
    onDone(await resetUserPasswordAction({ userId: user.id, temporaryPassword: values.temporaryPassword })),
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("users.resetPasswordTitle", { name: user.displayName })}</DialogTitle>
          <DialogDescription>
            {t("users.temporaryPasswordHint")} {t("users.resetPasswordHint")}
          </DialogDescription>
        </DialogHeader>
        <form id="reset-password-form" onSubmit={onSubmit} className="flex flex-col gap-1.5" noValidate>
          <Label htmlFor="temporaryPassword">{t("users.temporaryPassword")}</Label>
          <Input id="temporaryPassword" type="text" autoComplete="off" autoFocus {...form.register("temporaryPassword")} />
          <FieldMessage message={errors.temporaryPassword?.message} params={{ min: minPasswordLength }} />
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={isSubmitting}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="reset-password-form" disabled={isSubmitting}>
            {t("users.resetPassword")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
