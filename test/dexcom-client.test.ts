'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { describeDexcomError } from '../lib/dexcom/client';

/**
 * Only describeDexcomError is exercised here - it's the one pure function in client.ts. The rest
 * of the module (createDexcomClient/verifyDexcomLogin) exists to dynamically import() the
 * ESM-only dexcom-share-client and would need a real network round trip. Importing this module
 * is still safe from a test: that import() only ever runs inside those functions, so nothing
 * loads at module scope.
 */
function dexcomError(errorType: string, errorEnum?: string): Error {
  const error = new Error('raw library message') as Error & { errorType: string; errorEnum?: string };
  error.errorType = errorType;
  if (errorEnum) error.errorEnum = errorEnum;
  return error;
}

test('AccountError maps to a credentials message, not the library\'s own raw text', () => {
  assert.equal(
    describeDexcomError(dexcomError('AccountError')),
    'Could not sign in - check the username and password.',
  );
});

test('an account lockout is called out separately from an ordinary bad password', () => {
  // Retrying a lockout is actively harmful (it compounds the lockout), so this case must not
  // collapse into the generic "check the username and password" advice.
  assert.equal(
    describeDexcomError(dexcomError('AccountError', 'Maximum authentication attempts exceeded')),
    'Too many failed sign-in attempts. Wait a while before trying again.',
  );
});

test('an unrecognised errorEnum on an AccountError still falls back to the generic account message', () => {
  assert.equal(
    describeDexcomError(dexcomError('AccountError', 'Some Future Enum Value')),
    'Could not sign in - check the username and password.',
  );
});

test('ArgumentError points at the form fields rather than the credentials', () => {
  assert.equal(
    describeDexcomError(dexcomError('ArgumentError')),
    'Check that the username, password, and region are filled in correctly.',
  );
});

test('ServerError and SessionError are both reported as a transient Dexcom-side problem', () => {
  const expected = 'Dexcom Share is not responding right now. Try again in a moment.';
  assert.equal(describeDexcomError(dexcomError('ServerError')), expected);
  assert.equal(describeDexcomError(dexcomError('SessionError')), expected);
});

test('a plain Error with no errorType surfaces its own message', () => {
  assert.equal(describeDexcomError(new Error('getaddrinfo ENOTFOUND')), 'getaddrinfo ENOTFOUND');
});

test('a non-Error throw falls back to a generic message rather than stringifying junk', () => {
  const fallback = 'Could not sign in to Dexcom Share.';
  assert.equal(describeDexcomError(null), fallback);
  assert.equal(describeDexcomError(undefined), fallback);
  assert.equal(describeDexcomError('a bare string'), fallback);
  assert.equal(describeDexcomError({ unexpected: 'shape' }), fallback);
});

test('an unrecognised errorType falls through to the message, not to a wrong branch', () => {
  // A future library release adding a new errorType must degrade to its own text rather than
  // being silently mislabelled as e.g. a credentials problem.
  assert.equal(describeDexcomError(dexcomError('SomeNewErrorType')), 'raw library message');
});
