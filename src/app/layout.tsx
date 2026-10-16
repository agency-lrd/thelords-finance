import type { Metadata } from "next"
import { Geist, Geist_Mono, Unbounded } from "next/font/google"

import { TooltipProvider } from "@/components/ui/tooltip"
import { siteConfig } from "@/config/site"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin", "cyrillic"],
})

// Wide, heavy display face for headlines (THE LORDS ecosystem look); supports Cyrillic.
const unbounded = Unbounded({
  variable: "--font-unbounded",
  subsets: ["latin", "cyrillic"],
  weight: ["600", "700", "800", "900"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin", "cyrillic"],
})

export const metadata: Metadata = {
  title: {
    default: `${siteConfig.name} ${siteConfig.product}`,
    template: `%s · ${siteConfig.name} ${siteConfig.product}`,
  },
  description: siteConfig.description,
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ru"
      className={`dark ${geistSans.variable} ${geistMono.variable} ${unbounded.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  )
}
