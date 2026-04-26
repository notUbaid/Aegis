import * as React from "react";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { UIProvider } from "@/lib/ui";
import { AuthProvider } from "@aegis/ui-web";

const bodyFont = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600", "700"],
});

const monoFont = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Aegis Dashboard",
  description:
    "Aegis Dashboard — control-room operations board for venue incidents.",
  manifest: "/manifest.webmanifest",
  icons: [{ rel: "icon", url: "/icon.svg", type: "image/svg+xml" }],
};

export const viewport: Viewport = {
  themeColor: "#0A0E14",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${bodyFont.variable} ${monoFont.variable}`}>
      <body>
        {/* Runs before hydration to restore saved theme without flash */}
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem('aegis-theme');if(t==='light')document.documentElement.setAttribute('data-theme','light');}catch(e){}` }} />
        <UIProvider><AuthProvider>{children}</AuthProvider></UIProvider>
      </body>
    </html>
  );
}
