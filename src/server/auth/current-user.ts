import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "../db/client";
import { findSession, SESSION_COOKIE } from "./session";
import type { AuthSession } from "./types";

// Browsers cap cookie lifetime at 400 days; sessions themselves have no idle timeout.
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** The current session, read once per request. */
export const getCurrentSession = cache(async (): Promise<AuthSession | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return findSession(getDb(), token);
});

/**
 * For pages and server functions: redirects to login without a session and
 * to the password change screen while a temporary password is in use.
 */
export async function requireSession(options: { allowPendingPasswordChange?: boolean } = {}): Promise<AuthSession> {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.user.mustChangePassword && !options.allowPendingPasswordChange) redirect("/change-password");
  return session;
}

export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // Plain HTTP on the office LAN, so the cookie cannot be marked secure.
    secure: false,
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
