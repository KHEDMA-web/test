import type { Metadata } from "next";
import "./globals.css";
import { Shell } from "@/components/Shell";

export const metadata: Metadata = {
  title: "ClipFlow — du rush à la mise en ligne",
  description:
    "Plateforme de clipping complète : recrutement des clippers sur Whop, détection des meilleurs moments et hooks, montage hybride, publication via Metricool.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
