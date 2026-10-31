import { AuthPage } from './auth-page';
import { googleAuthConfigured } from '@/lib/server/auth';
import { authErrorMessage } from '@/lib/auth-feedback';

export type AuthPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function AuthScreen({ mode, searchParams }: AuthPageProps & { mode: 'login' | 'signup' }) {
  const params = await searchParams;
  const code = typeof params.auth_error === 'string' ? params.auth_error : undefined;
  return <AuthPage mode={mode} error={authErrorMessage(code)} resetRequired={code === 'session_invalid' || code === 'signin_failed' || code === 'identity_conflict'} googleConfigured={googleAuthConfigured()} />;
}
