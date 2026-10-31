'use client';

import { useState } from 'react';
import { LogOut } from 'lucide-react';
import './auth.css';

export type WorkspaceUser = {
  name: string;
  email: string;
  provider?: 'google';
};

export { authFeedbackFromSearch, type AuthFeedback } from '@/lib/auth-feedback';

export function GoogleMark({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="google-mark"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-1.99 3.02v2.51h3.23c1.89-1.74 2.98-4.3 2.98-7.36Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.23-2.51c-.9.6-2.05.97-3.39.97-2.61 0-4.82-1.76-5.61-4.12H3.05v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.39 13.93A6 6 0 0 1 6.08 12c0-.67.11-1.32.31-1.93V7.48H3.05A10 10 0 0 0 2 12c0 1.61.39 3.14 1.05 4.52l3.34-2.59Z"/><path fill="#EA4335" d="M12 5.95c1.47 0 2.79.51 3.82 1.52l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.95 5.48l3.34 2.59C7.18 7.71 9.39 5.95 12 5.95Z"/></svg>;
}

export function GoogleAuthForm({ label, autoFocus = false }: { label?: string; autoFocus?: boolean }) {
  const [opening, setOpening] = useState(false);
  return <form action="/auth/google" method="post" target="_top" className="google-auth-form" onSubmit={() => setOpening(true)}>
    <input type="hidden" name="intent" value="signin"/>
    <button type="submit" className="button google-auth-button full-width" autoFocus={autoFocus} disabled={opening} aria-busy={opening}><GoogleMark/>{opening ? 'Opening Google…' : label || 'Continue with Google'}</button>
  </form>;
}

export function SignOutForm({ reset = false }: { reset?: boolean }) {
  const [leaving, setLeaving] = useState(false);
  return <form action="/auth/logout" method="post" target="_top" className={`auth-signout-form${reset ? ' auth-reset-form' : ''}`} onSubmit={() => setLeaving(true)}><button type="submit" disabled={leaving}><LogOut size={16}/>{leaving ? 'Signing out…' : reset ? 'Reset sign-in' : 'Sign out'}</button></form>;
}
