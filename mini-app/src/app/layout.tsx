import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SplitCat",
  description: "Split the bill, not the friendship."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Telegram WebApp bootstrap script — provides window.Telegram.WebApp */}
        <script src="https://telegram.org/js/telegram-web-app.js" async />
      </head>
      <body className="min-h-screen bg-tg-bg text-tg-text">{children}</body>
    </html>
  );
}
