import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clipify",
  description:
    "Turn podcasts and interviews into short clips for TikTok, Reels, and Shorts. Clipify finds the best moments so you can grow your audience faster.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorPrimary: "#9333ea",
          colorBackground: "#111827",
          colorText: "#f3f4f6",
          colorInputBackground: "#1f2937",
          colorInputText: "#f3f4f6",
        },
        elements: {
          userButtonPopoverCard:
            "bg-gray-900 border border-gray-700 shadow-2xl rounded-xl",
          userButtonPopoverMain: "text-gray-100",
          userButtonPopoverActions: "border-t border-gray-800",
          userButtonPopoverActionButton:
            "text-gray-200 hover:bg-gray-800 hover:text-white transition-colors",
          userButtonPopoverActionButtonText: "text-gray-200 font-medium",
          userButtonPopoverActionButtonIcon: "text-gray-400",
          userButtonPopoverFooter:
            "border-t border-gray-800 text-gray-500",
          userPreviewMainIdentifier: "text-white font-semibold",
          userPreviewSecondaryIdentifier: "text-gray-400",
        },
      }}
    >
      <html lang="en">
        <body className="min-h-screen antialiased">{children}</body>
      </html>
    </ClerkProvider>
  );
}
