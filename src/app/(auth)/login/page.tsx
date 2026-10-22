import { redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/current-user";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  if (await getCurrentSession()) redirect("/");
  return <LoginForm />;
}
