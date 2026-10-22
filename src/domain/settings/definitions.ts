import { z } from "zod";

/**
 * Typed setting registry. Initial values come only from seed/settings.json;
 * this file defines keys and validation, never business values.
 * The full settings system (groups, overrides, impact preview) is build step 2.
 */
export const settingDefinitions = {
  /** Failed logins before an account is locked; 0 disables lockout. */
  "auth.loginLockoutAttempts": z.number().int().min(0).max(100),
  "auth.minPasswordLength": z.number().int().min(4).max(128),
} as const;

export type SettingKey = keyof typeof settingDefinitions;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingDefinitions)[K]>;

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingDefinitions, key);
}

export function parseSettingValue<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  return settingDefinitions[key].parse(value) as SettingValue<K>;
}
