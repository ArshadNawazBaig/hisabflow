import type { Metadata } from 'next';
import { AuthScreen, type AuthPageProps } from '@/components/hisab/auth-screen';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Create account — HisabFlow', robots: { index: false, follow: false } };
export default function SignupPage(props: AuthPageProps) {
  return <AuthScreen {...props} mode="signup" />;
}
