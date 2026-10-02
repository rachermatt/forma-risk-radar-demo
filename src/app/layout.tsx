import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const appOrigin = process.env.APP_ORIGIN ?? "http://localhost:8080";

export const metadata: Metadata = {
  metadataBase: new URL(appOrigin),
  title: {
    default: "Forma Risk Radar",
    template: "%s · Forma Risk Radar",
  },
  description:
    "Explore Forma Risk Radar with synthetic construction portfolio data. No Autodesk sign-in required.",
  openGraph: {
    title: "Forma Risk Radar",
    description: "Enterprise risk intelligence for construction portfolios.",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Forma Risk Radar — Enterprise Risk Intelligence" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Forma Risk Radar",
    description: "Enterprise risk intelligence for construction portfolios.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
