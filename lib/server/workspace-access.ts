type WorkspaceOwnerFailure = { status: 400 | 409; error: string; code: 'WORKSPACE_OWNER_REQUIRED' | 'WORKSPACE_ACCOUNT_CHANGED' };

/** Pin each save to the account which loaded the snapshot, independently of its revision. */
export function workspaceOwnerFailure(request: Request, authenticatedOwner: string): WorkspaceOwnerFailure | null {
  const expectedOwner = request.headers.get('X-Workspace-Owner');
  if (!expectedOwner) return {
    status: 400,
    error: 'Reload this workspace before saving your changes.',
    code: 'WORKSPACE_OWNER_REQUIRED',
  };
  if (expectedOwner !== encodeURIComponent(authenticatedOwner)) return {
    status: 409,
    error: 'A different account is signed in. Sign in with the original account before retrying your changes.',
    code: 'WORKSPACE_ACCOUNT_CHANGED',
  };
  return null;
}
