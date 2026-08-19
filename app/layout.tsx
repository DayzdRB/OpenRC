import type { Metadata } from "next";
import "./globals.css";
import "./openrc-v02.css";
import "./openrc-v03.css";

export const metadata: Metadata = {
  title: "OpenRC — Open Radar Control",
  description: "A simulation-first browser air traffic control simulator.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
