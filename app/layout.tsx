import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clipify",
  description:
    "Turn long videos into shareable clips optimized for TikTok, Reels, and Shorts.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
