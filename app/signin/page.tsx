import type { Metadata } from 'next';
import { AuthScreen, type AuthPageProps } from '@/components/hisab/auth-screen';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign in — HisabFlow', robots: { index: false, follow: false }, alternates: { canonical: '/login' } };
export default function SigninPage(props: AuthPageProps) {
  return <AuthScreen {...props} mode="login" />;
}
