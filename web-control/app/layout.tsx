import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { cn } from "@/lib/utils";
import "./globals.css";

// Decision 6A: IBM Plex Sans for UI text, IBM Plex Mono for every live number and log line.
const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-sans" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Mission",
  description: "Xbox controller to Pixhawk boat over MAVLink",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Decision 14A: dark theme only for now.
  return <html lang="en" className={cn("dark h-full", sans.variable, mono.variable)}><body className="h-full font-sans antialiased">{children}</body></html>;
}
