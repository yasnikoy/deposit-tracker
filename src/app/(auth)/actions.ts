"use server";

import { redirect } from "next/navigation";
import { loginSchema, changePasswordSchema } from "@/lib/schemas/users";
import { runAction } from "@/server/actions";
import {
  clearSessionCookie,
  getCurrentSession,
  requireSession,
  setSessionCookie,
} from "@/server/auth/current-user";
import { attemptLogin } from "@/server/auth/login";
import { createSession, revokeSession } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { DomainError, type ActionResult } from "@/server/errors";
import { logger } from "@/server/logger";
import { changeOwnPassword, minPasswordLength } from "@/server/users";

export async function loginAction(input: unknown): Promise<ActionResult<undefined>> {
  return runAction(loginSchema, input, async (data) => {
    const db = getDb();
    const result = await attemptLogin(db, data);
    if (!result.ok) {
      logger.info({ username: data.username, reason: result.reason }, "login rejected");
      throw new DomainError(result.reason === "locked" ? "auth.login.locked" : "auth.login.invalid");
    }
    await setSessionCookie(createSession(db, result.userId));
    logger.info({ userId: result.userId }, "login");
    redirect("/");
  });
}

export async function logoutAction(): Promise<void> {
  const session = await getCurrentSession();
  if (session) revokeSession(getDb(), session.sessionId);
  await clearSessionCookie();
  redirect("/login");
}

export async function changePasswordAction(input: unknown): Promise<ActionResult<undefined>> {
  const session = await requireSession({ allowPendingPasswordChange: true });
  const db = getDb();
  return runAction(changePasswordSchema(minPasswordLength(db)), input, async (data) => {
    await changeOwnPassword(db, session, { currentPassword: data.currentPassword, newPassword: data.newPassword });
    return undefined;
  });
}
