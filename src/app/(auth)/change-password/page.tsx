import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { minPasswordLength } from "@/server/users";
import { ChangePasswordForm } from "./change-password-form";

export default async function ChangePasswordPage() {
  const { user } = await requireSession({ allowPendingPasswordChange: true });
  return <ChangePasswordForm forced={user.mustChangePassword} minLength={minPasswordLength(getDb())} />;
}
