import { Forbidden } from "@/components/forbidden";
import { t } from "@/i18n";
import { can } from "@/server/auth/can";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import { getTableLayout } from "@/server/preferences";
import { listUsers, minPasswordLength } from "@/server/users";
import { UsersScreen } from "./users-screen";

export default async function UsersPage() {
  const { user } = await requireSession();
  if (!can(user, "user.list").allowed) return <Forbidden />;
  const db = getDb();

  return (
    <>
      <h1 className="text-lg font-semibold">{t("users.title")}</h1>
      <UsersScreen
        users={listUsers(db, user)}
        layout={getTableLayout(db, user.id, "users")}
        minPasswordLength={minPasswordLength(db)}
        currentUserId={user.id}
      />
    </>
  );
}
