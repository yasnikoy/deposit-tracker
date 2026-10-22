import type { Role } from "@/domain/roles";

export type AuthUser = {
  id: number;
  username: string;
  displayName: string;
  roles: Role[];
  active: boolean;
  mustChangePassword: boolean;
};

/** The authenticated user plus the session that made the request. */
export type AuthSession = { user: AuthUser; sessionId: string };
