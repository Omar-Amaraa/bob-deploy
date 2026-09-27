import type { AppError, ErrorCode } from '@bob-deploy/contracts';

export interface ErrorCopy {
  title: string;
  body: string;
  action?: 'Try again' | 'Open logs' | 'Unlock';
}

export const ERROR_CATALOG = {
  LOCKED: { title: 'Bob Deploy is locked', body: 'Unlock Bob Deploy to continue.', action: 'Unlock' },
  NO_ACCOUNT: { title: 'No account is set up', body: 'Create your local Bob Deploy account to continue.' },
  ACCOUNT_EXISTS: {
    title: 'An account already exists',
    body: 'Unlock the existing account instead of creating another one.',
  },
  BAD_PASSWORD: {
    title: 'That password is not right',
    body: 'Check the password and try again.',
    action: 'Try again',
  },
  WEAK_PASSWORD: {
    title: 'Choose a stronger password',
    body: 'Use at least 12 characters and avoid common words or personal details.',
  },
  TOO_MANY_ATTEMPTS: { title: 'Too many attempts', body: 'Wait for the countdown, then try again.' },
  BAD_RECOVERY_CODE: {
    title: 'That recovery code was not accepted',
    body: 'Check every character and try again.',
  },
  VALIDATION: { title: 'Check what you entered', body: 'One or more fields need your attention.' },
  NOT_FOUND: { title: 'We could not find that', body: 'It may have been removed or changed.' },
  CONFLICT: {
    title: 'That conflicts with something already saved',
    body: 'Review the existing item and try a different choice.',
  },
  JOB_RUNNING: {
    title: 'Bob is already working',
    body: 'Wait for the current task to finish before starting another one.',
  },
  CANCELLED: {
    title: 'The task was cancelled',
    body: 'No further changes will be made.',
    action: 'Try again',
  },
  BOB_NOT_INSTALLED: {
    title: 'Bob Shell was not found',
    body: 'Install Bob Shell or choose the Bob program on this computer.',
  },
  BOB_NODE_TOO_OLD: {
    title: 'Node.js is too old for Bob',
    body: 'Install Node.js 22.15 or newer, then check Bob again.',
  },
  BOB_LICENSE_NOT_ACCEPTED: {
    title: 'Bob’s license is not accepted',
    body: 'Accept the license terms before asking Bob to work.',
  },
  BOB_AUTH_FAILED: {
    title: 'Bob could not sign in',
    body: 'Replace the Bob API key and make sure it has the Inference scope.',
  },
  BOB_FAILED: {
    title: 'Bob could not finish the task',
    body: 'Review what Bob reported, then try again.',
    action: 'Try again',
  },
  BOB_BAD_OUTPUT: {
    title: 'Bob returned an answer we could not use',
    body: 'Try again. If this keeps happening, open the logs for details.',
    action: 'Open logs',
  },
  SSH_UNREACHABLE: {
    title: "We couldn't reach your server",
    body: "Check the IP address and that the server is running in your provider's dashboard.",
    action: 'Try again',
  },
  SSH_AUTH_FAILED: {
    title: 'The server did not accept the sign-in details',
    body: 'Check the login name, password or key from your provider.',
  },
  SSH_HOSTKEY_MISMATCH: {
    title: "Your server's identity changed",
    body: 'This can happen after reinstalling the server, or it can mean someone is intercepting the connection. Contact your provider before continuing.',
  },
  SSH_HOSTKEY_REJECTED: {
    title: "The server's identity was not accepted",
    body: 'Check the fingerprint in your provider dashboard before trying again.',
  },
  SSH_TIMEOUT: {
    title: 'The server took too long to answer',
    body: 'Check that the server is running and accepts secure sign-ins.',
    action: 'Try again',
  },
  DNS_MISMATCH: {
    title: 'The domain points somewhere else',
    body: "Update the domain's A record to point to this server, then check again.",
    action: 'Try again',
  },
  UNSUPPORTED_OS: {
    title: 'This server system is not supported yet',
    body: 'Use a fresh Ubuntu 22.04 or Ubuntu 24.04 server.',
  },
  UNSUPPORTED_STACK: {
    title: 'This project type is not supported yet',
    body: 'Bob Deploy could not find a safe way to build and run this project.',
  },
  SERVER_NOT_FRESH: {
    title: 'This server is not empty',
    body: 'Use a fresh server so Bob Deploy does not overwrite an existing setup.',
  },
  HOST_AUTH_FAILED: {
    title: 'Your hosting token was not accepted',
    body: 'Create a new token in your hosting account and try again.',
  },
  HOST_API_ERROR: {
    title: 'Your hosting provider could not complete the request',
    body: 'Wait a moment and try again.',
    action: 'Try again',
  },
  HOST_UNSUPPORTED: {
    title: 'That hosting provider is not available',
    body: 'Choose Netlify, Vercel or your own server.',
  },
  BUILD_FAILED: {
    title: 'Bob could not prepare the project',
    body: 'Bob tried to fix the project, but it still was not ready to publish.',
    action: 'Try again',
  },
  HEALTHCHECK_FAILED: {
    title: 'The new version did not start',
    body: 'The new version did not start, so your site stays on the previous version.',
    action: 'Try again',
  },
  HARDENING_FAILED: {
    title: 'Securing the server failed',
    body: 'Securing the server failed. The previous settings were restored.',
  },
  INTERNAL: {
    title: 'Something went wrong',
    body: 'Something went wrong. Details are in the log.',
    action: 'Open logs',
  },
} satisfies Record<ErrorCode, ErrorCopy>;

export function errorCopy(error: AppError): ErrorCopy & { body: string } {
  const copy = ERROR_CATALOG[error.code];
  return { ...copy, body: error.message || copy.body };
}
