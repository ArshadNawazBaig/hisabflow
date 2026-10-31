import type { Metadata } from 'next';
import './globals.css';
import './typography.css';
export const metadata: Metadata = {
  title: 'HisabFlow — Business, in balance',
  description: 'Your private workspace for companies, truck-wise deliveries, payments, and reviewed ledger imports.',
  icons: {icon: '/favicon.svg', shortcut:'/favicon.svg'},
};
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="en"><body>{children}</body></html>;
}
