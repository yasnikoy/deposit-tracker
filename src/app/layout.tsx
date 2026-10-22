import type { Metadata } from "next";
import { Toaster } from "@/components/ui/sonner";
import { t } from "@/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: t("app.name"),
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="tr" className="h-full antialiased">
      <body className="min-h-full font-sans text-sm">
        {children}
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
