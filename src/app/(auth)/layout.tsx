import { t } from "@/i18n";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="bg-muted/40 flex min-h-screen flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-xl font-semibold">{t("app.name")}</h1>
      {children}
    </main>
  );
}
