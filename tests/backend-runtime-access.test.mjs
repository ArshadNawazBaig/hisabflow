import test from 'node:test';
import assert from 'node:assert/strict';
import { allowLocalAuthentication, approvedAppOrigin, WorkspaceAuthError } from '../lib/server/auth-policy.ts';
import { workspaceOwnerFailure } from '../lib/server/workspace-access.ts';

test('built local authentication requires the exact trusted launcher binding', () => {
  assert.equal(allowLocalAuthentication(false, '1'), true);
  assert.equal(allowLocalAuthentication(true), true);
  for (const value of [undefined, null, '', false, true, 1, 'true', '01', 'localhost']) {
    assert.equal(allowLocalAuthentication(false, value), false);
  }
});

test('trusted local runtime allows only loopback HTTP without production origin configuration', () => {
  for (const origin of ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://[::1]:5173']) {
    assert.equal(approvedAppOrigin(new Request(origin), allowLocalAuthentication(false, '1')), origin);
    assert.throws(() => approvedAppOrigin(new Request(origin), allowLocalAuthentication(false)), WorkspaceAuthError);
  }
  for (const origin of ['http://192.168.1.2:5173', 'http://evil.example', 'https://evil.example']) {
    assert.throws(() => approvedAppOrigin(new Request(origin), allowLocalAuthentication(false, '1')), WorkspaceAuthError);
  }
});

test('production origin checks stay active without a trusted local binding', () => {
  const origin = 'https://hisabflow.example';
  assert.equal(approvedAppOrigin(new Request(origin), allowLocalAuthentication(false), origin), origin);
  assert.throws(() => approvedAppOrigin(new Request('http://127.0.0.1', { headers: { Host: 'localhost', 'X-Forwarded-Host': 'localhost' } }), allowLocalAuthentication(false), origin), WorkspaceAuthError);
});

const saveRequest = owner => new Request('https://hisabflow.example/api/workspace', {
  method: 'PUT', headers: owner === undefined ? {} : { 'X-Workspace-Owner': owner },
});
test('saves require the original loaded owner even when the newly signed-in account has the same revision', () => {
  assert.equal(workspaceOwnerFailure(saveRequest(encodeURIComponent('owner-A')), 'owner-A'), null);
  assert.equal(workspaceOwnerFailure(saveRequest(encodeURIComponent('owner-A')), 'owner-B')?.code, 'WORKSPACE_ACCOUNT_CHANGED');
  assert.equal(workspaceOwnerFailure(saveRequest(encodeURIComponent('owner-A')), 'owner-B')?.status, 409);
  assert.equal(workspaceOwnerFailure(saveRequest(undefined), 'owner-A')?.code, 'WORKSPACE_OWNER_REQUIRED');
  assert.equal(workspaceOwnerFailure(saveRequest(''), 'owner-A')?.status, 400);
});

test('legacy Unicode and reserved owner characters can be pinned safely in a header', () => {
  const owner = 'owner:اردو/part%20';
  assert.equal(workspaceOwnerFailure(saveRequest(encodeURIComponent(owner)), owner), null);
  assert.equal(workspaceOwnerFailure(saveRequest(encodeURIComponent(owner)), 'another-owner')?.status, 409);
});
