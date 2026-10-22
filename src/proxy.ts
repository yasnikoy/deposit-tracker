import { NextResponse, type NextRequest } from "next/server";

// Optimistic check only: real authentication and can() run in every page and server function.
const SESSION_COOKIE = "dt_session";

export function proxy(request: NextRequest) {
  if (!request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!login|api/health|_next/static|_next/image|favicon.ico).*)"],
};
