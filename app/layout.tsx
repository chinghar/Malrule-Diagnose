import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "malrule-diagnose",
  description: "Deterministic malrule diagnosis from a child's arithmetic answers.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
