import type { Metadata, Viewport } from 'next';
import { PwaProvider } from '@/components/hisab/pwa-support';
import './globals.css';
import './typography.css';
export const metadata: Metadata = {
  title: 'HisabFlow — Business, in balance',
  description: 'Your private workspace for companies, truck-wise deliveries, payments, and reviewed ledger imports.',
  applicationName: 'HisabFlow',
  manifest: '/manifest.webmanifest',
  appleWebApp: {capable:true,title:'HisabFlow',statusBarStyle:'default'},
  // Vinext emits the standard mobile capability tag from appleWebApp.
  other: {'apple-mobile-web-app-capable':'yes'},
  icons: {icon: '/favicon.svg', shortcut:'/favicon.svg',apple:[{url:'/icons/apple-touch-icon.png',sizes:'180x180',type:'image/png'}]},
};
export const viewport: Viewport = {width:'device-width',initialScale:1,viewportFit:'cover',interactiveWidget:'resizes-content',themeColor:'#176b47'};
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="en"><body><PwaProvider>{children}</PwaProvider></body></html>;
}
