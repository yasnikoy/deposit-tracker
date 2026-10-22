"use server";

import {
  createUserSchema,
  resetPasswordSchema,
  setUserActiveSchema,
  updateUserSchema,
  userIdOnlySchema,
} from "@/lib/schemas/users";
import { runAction } from "@/server/actions";
import { requireSession } from "@/server/auth/current-user";
import { getDb } from "@/server/db/client";
import type { ActionResult } from "@/server/errors";
import {
  createUser,
  minPasswordLength,
  resetUserPassword,
  setUserActive,
  unlockUser,
  updateUser,
} from "@/server/users";

// Each function validates its input; the service layer runs can() and writes the audit log.

export async function createUserAction(input: unknown): Promise<ActionResult<number>> {
  const { user } = await requireSession();
  const db = getDb();
  return runAction(createUserSchema(minPasswordLength(db)), input, (data) =>
    createUser(db, user, { ...data, password: data.temporaryPassword }),
  );
}

export async function updateUserAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(updateUserSchema, input, (data) => updateUser(getDb(), user, data));
}

export async function resetUserPasswordAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  const db = getDb();
  return runAction(resetPasswordSchema(minPasswordLength(db)), input, (data) => resetUserPassword(db, user, data));
}

export async function setUserActiveAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(setUserActiveSchema, input, (data) => setUserActive(getDb(), user, data));
}

export async function unlockUserAction(input: unknown): Promise<ActionResult<void>> {
  const { user } = await requireSession();
  return runAction(userIdOnlySchema, input, (data) => unlockUser(getDb(), user, data));
}
