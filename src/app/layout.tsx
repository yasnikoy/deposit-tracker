import type { Metadata } from "next";
import { Toaster } from "@/components/ui/sonner";
import { t } from "@/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: t("app.name"),
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Browser extensions add classes to <html>/<body> before React loads (e.g. "vc-init");
    // ignore attribute differences on these two elements only, not inside the page.
    <html lang="tr" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full font-sans text-sm" suppressHydrationWarning>
        {children}
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
