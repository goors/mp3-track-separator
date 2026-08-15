import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import QueryProvider from "@/providers/query-provider";

import {Toaster} from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Track separator",
  description: "Track separator",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
          <QueryProvider>
              <div className="flex min-h-screen flex-col">
                  <main className="flex-1">{children}</main>
                  <Toaster />
              </div>
          </QueryProvider>
      </body>
    </html>
  );
}
