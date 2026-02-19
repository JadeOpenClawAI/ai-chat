import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_APP_NAME ?? 'AI Chat',
  description:
    'A production-quality AI chat application with multi-provider support, context management, and tool calling.',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen overflow-y-auto overflow-x-hidden antialiased">{children}</body>
    </html>
  )
}
