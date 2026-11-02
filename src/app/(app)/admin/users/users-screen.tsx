"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table/data-table";
import { dataTableColumns } from "@/components/data-table/features";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ROLES, type Role } from "@/domain/roles";
import { t, type TranslationKey } from "@/i18n";
import type { TableLayout } from "@/lib/schemas/table-layout";
import { formatTimestamp } from "@/lib/format";
import type { ActionResult } from "@/server/errors";
import type { UserListItem } from "@/server/users";
import { setUserActiveAction, unlockUserAction } from "./actions";
import { ResetPasswordDialog, UserFormDialog } from "./user-dialogs";

type UserStatus = "active" | "inactive" | "locked";
const STATUS_LABEL: Record<UserStatus, TranslationKey> = {
  active: "users.active",
  inactive: "users.inactive",
  locked: "users.locked",
};
const statusOf = (user: UserListItem): UserStatus => (!user.active ? "inactive" : user.locked ? "locked" : "active");
const roleLabels = (roles: Role[]) => roles.map((role) => t(`roles.${role}`)).join(", ");

type DialogState =
  | { kind: "create" }
  | { kind: "edit"; user: UserListItem }
  | { kind: "resetPassword"; user: UserListItem }
  | { kind: "deactivate"; user: UserListItem }
  | null;

export function UsersScreen({
  users,
  layout,
  minPasswordLength,
  currentUserId,
}: {
  users: UserListItem[];
  layout: TableLayout | null;
  minPasswordLength: number;
  currentUserId: number;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState>(null);
  const close = () => setDialog(null);

  /** Shows the result of a server function and refreshes the list on success. */
  const finish = (result: ActionResult<unknown>, success: TranslationKey): boolean => {
    if (!result.ok) {
      toast.error(t(result.error, result.params));
      return false;
    }
    toast.success(t(success));
    router.refresh();
    return true;
  };

  const columns = useMemo(() => {
    const col = dataTableColumns<UserListItem>();
    return col.columns([
      col.accessor("username", { meta: { label: "users.username", filter: "text" }, sortFn: "turkishText" }),
      col.accessor("displayName", { meta: { label: "users.displayName", filter: "text" }, sortFn: "turkishText" }),
      col.accessor("roles", {
        meta: {
          label: "users.roles",
          toText: (value) => roleLabels(value as Role[]),
          filter: { options: ROLES.map((role) => ({ value: role, label: `roles.${role}` as const })) },
        },
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex gap-1">
            {row.original.roles.map((role) => (
              <Badge key={role} variant="secondary">
                {t(`roles.${role}`)}
              </Badge>
            ))}
          </div>
        ),
      }),
      col.accessor(statusOf, {
        id: "status",
        meta: {
          label: "users.status",
          toText: (value) => t(STATUS_LABEL[value as UserStatus]),
          filter: { options: (Object.keys(STATUS_LABEL) as UserStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] })) },
        },
        sortFn: "turkishText",
        cell: ({ row }) => {
          const status = statusOf(row.original);
          return (
            <div className="flex items-center gap-1">
              <Badge variant={status === "active" ? "outline" : status === "locked" ? "destructive" : "secondary"}>{t(STATUS_LABEL[status])}</Badge>
              {row.original.mustChangePassword && status === "active" && (
                <span className="text-muted-foreground text-xs">{t("users.mustChangePassword")}</span>
              )}
            </div>
          );
        },
      }),
      col.accessor("createdAt", {
        meta: { label: "users.createdAt", toText: (value) => formatTimestamp(value as string) },
        sortFn: "basic",
        cell: ({ getValue }) => formatTimestamp(getValue()),
      }),
      col.display({
        id: "actions",
        meta: { label: "common.actions", searchable: false },
        enableHiding: false,
        cell: ({ row }) => {
          const user = row.original;
          return (
            <div onClick={(event) => event.stopPropagation()}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-7" aria-label={t("common.actions")}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setDialog({ kind: "edit", user })}>{t("users.edit")}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDialog({ kind: "resetPassword", user })}>
                    {t("users.resetPassword")}
                  </DropdownMenuItem>
                  {user.locked && (
                    <DropdownMenuItem
                      onSelect={async () => finish(await unlockUserAction({ userId: user.id }), "users.toast.unlocked")}
                    >
                      {t("users.unlock")}
                    </DropdownMenuItem>
                  )}
                  {user.active ? (
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={user.id === currentUserId}
                      onSelect={() => setDialog({ kind: "deactivate", user })}
                    >
                      {t("users.deactivate")}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      onSelect={async () =>
                        finish(await setUserActiveAction({ userId: user.id, active: true }), "users.toast.reactivated")
                      }
                    >
                      {t("users.reactivate")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      }),
    ]);
    // finish/setDialog only use stable setters and the router.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId]);

  return (
    <>
      <DataTable
        tableId="users"
        data={users}
        columns={columns}
        getRowId={(user) => String(user.id)}
        initialLayout={layout}
        onOpenRow={(user) => setDialog({ kind: "edit", user })}
        rowClassName={(user) => (user.active ? undefined : "text-muted-foreground")}
        toolbar={
          <Button size="sm" onClick={() => setDialog({ kind: "create" })}>
            <Plus /> {t("users.new")}
          </Button>
        }
      />

      {(dialog?.kind === "create" || dialog?.kind === "edit") && (
        <UserFormDialog
          user={dialog.kind === "edit" ? dialog.user : null}
          minPasswordLength={minPasswordLength}
          onDone={(result, success) => finish(result, success) && close()}
          onCancel={close}
        />
      )}
      {dialog?.kind === "resetPassword" && (
        <ResetPasswordDialog
          user={dialog.user}
          minPasswordLength={minPasswordLength}
          onDone={(result) => finish(result, "users.toast.passwordReset") && close()}
          onCancel={close}
        />
      )}
      {dialog?.kind === "deactivate" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && close()}
          title={t("users.deactivate")}
          description={t("users.deactivateConfirm", { name: dialog.user.displayName })}
          items={[`${dialog.user.username} — ${dialog.user.displayName}`]}
          confirmLabel={t("users.deactivate")}
          destructive
          onConfirm={async () => {
            if (finish(await setUserActiveAction({ userId: dialog.user.id, active: false }), "users.toast.deactivated")) close();
          }}
        />
      )}
    </>
  );
}
