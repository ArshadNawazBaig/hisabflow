import test from 'node:test';
import assert from 'node:assert/strict';
import { authErrorMessage, authFeedbackFromSearch } from '../lib/auth-feedback.ts';

test('login errors use fixed copy instead of reflecting arbitrary URL content',()=>{
  const untrusted='<script>untrusted-auth-message</script>';
  const feedback=authFeedbackFromSearch('?auth_error='+encodeURIComponent(untrusted));
  assert.equal(feedback.kind,'error');
  assert.equal(feedback.message,authErrorMessage('signin_failed'));
  assert.equal(feedback.message.includes(untrusted),false);
});

test('unrecognized sign-in success claims have no visible success feedback',()=>{
  assert.equal(authFeedbackFromSearch('?auth_success=arbitrary-account'),null);
  assert.equal(authFeedbackFromSearch(''),null);
});

test('invalid sessions have a distinct recovery message and errors override success claims',()=>{
  const feedback=authFeedbackFromSearch('?auth_success=google_signed_in&auth_error=session_invalid');
  assert.equal(feedback.kind,'error');
  assert.match(feedback.message,/Reset sign-in/);
});
