import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_APP_NAME ?? 'AI Chat',
  description:
    'A production-quality AI chat application with multi-provider support, context management, and tool calling.',
  icons: {
    icon: '/favicon.ico',
    shortcut: '/favicon.ico',
    apple: '/favicon.ico',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const themeInitScript = `
    (function () {
      try {
        var pref = localStorage.getItem('ai-chat:theme');
        var theme = (pref === 'light' || pref === 'dark' || pref === 'system') ? pref : 'system';
        var isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.classList.toggle('dark', isDark);
      } catch {}
    })();
  `

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen overflow-y-auto overflow-x-hidden antialiased">{children}</body>
    </html>
  )
}
