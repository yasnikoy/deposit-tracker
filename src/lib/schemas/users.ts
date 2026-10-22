import { z } from "zod";
import { ROLES } from "@/domain/roles";
import type { TranslationKey } from "@/i18n";

// Messages are translation keys; forms render them with t().
const msg = (key: TranslationKey) => key;

export const usernameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{2,64}$/, msg("users.errors.usernameFormat"));

export const displayNameSchema = z.string().trim().min(1, msg("common.required")).max(100);

export const rolesSchema = z
  .array(z.enum(ROLES))
  .min(1, msg("users.errors.rolesRequired"))
  .transform((roles) => [...new Set(roles)]);

/** Minimum length is a setting, so the schema is built per request. */
export const passwordSchema = (minLength: number) =>
  z.string().min(minLength, msg("auth.changePassword.tooShort")).max(256);

export const userIdSchema = z.number().int().positive();

export const createUserSchema = (minPasswordLength: number) =>
  z.object({
    username: usernameSchema,
    displayName: displayNameSchema,
    roles: rolesSchema,
    temporaryPassword: passwordSchema(minPasswordLength),
  });

export const updateUserSchema = z.object({
  userId: userIdSchema,
  displayName: displayNameSchema,
  roles: rolesSchema,
});

export const resetPasswordSchema = (minPasswordLength: number) =>
  z.object({ userId: userIdSchema, temporaryPassword: passwordSchema(minPasswordLength) });

export const setUserActiveSchema = z.object({ userId: userIdSchema, active: z.boolean() });

export const userIdOnlySchema = z.object({ userId: userIdSchema });

export const loginSchema = z.object({
  username: z.string().trim().min(1, msg("common.required")).max(64),
  password: z.string().min(1, msg("common.required")).max(256),
});

export const changePasswordSchema = (minPasswordLength: number) =>
  z
    .object({
      currentPassword: z.string().min(1, msg("common.required")).max(256),
      newPassword: passwordSchema(minPasswordLength),
      confirmPassword: z.string(),
    })
    .refine((v) => v.newPassword === v.confirmPassword, {
      message: msg("auth.changePassword.mismatch"),
      path: ["confirmPassword"],
    });
