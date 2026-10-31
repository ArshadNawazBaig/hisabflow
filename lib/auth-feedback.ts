export type AuthFeedback = { kind: 'success' | 'error'; message: string };

const successMessages: Record<string, string> = {
  google_signed_in: 'You’re signed in with Google.',
};
const errorMessages: Record<string, string> = {
  cancelled: 'Google sign-in was cancelled. Please try again when you’re ready.',
  expired: 'This sign-in attempt expired. Start Google sign-in again.',
  identity_conflict: 'This Google account could not open the workspace. Use the Google account you use for this business.',
  signin_failed: 'Google sign-in could not be completed. Please try again.',
  session_invalid: 'Your session has expired or could not be verified. Reset sign-in, then continue with Google.',
  unavailable: 'Google sign-in is temporarily unavailable. Please try again shortly.',
};

export function authErrorMessage(code: string | undefined): string | undefined {
  return code ? errorMessages[code] || errorMessages.signin_failed : undefined;
}

export function authFeedbackFromSearch(search: string): AuthFeedback | null {
  const params = new URLSearchParams(search);
  const error = params.get('auth_error');
  if (error) return { kind: 'error', message: authErrorMessage(error)! };
  const success = params.get('auth_success');
  return success && successMessages[success] ? { kind: 'success', message: successMessages[success] } : null;
}
