import type { Metadata } from "next";
import { Inter_Tight, JetBrains_Mono, Public_Sans } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const display = Inter_Tight({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-inter-tight" });
const body = Public_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-public-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: "Maple Planner",
  description:
    "Enter your MapleStory character's gear, potentials, flames and stats. Hover any slot to see exactly what to fix next.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <header className="mast">
          <div className="mast-in">
            <h1 style={{ fontSize: "1.05rem", fontWeight: 700, marginRight: "auto" }}>
              Maple<span style={{ color: "var(--gold)" }}>Planner</span>
            </h1>
            <Link href="/" className="navlink">Planner</Link>
            <Link href="/guide" className="navlink">Guide</Link>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
