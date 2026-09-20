# MFA and passkeys

`mfa.ts` ran under the test suite in `sessions-and-passwords.md` (TOTP accept and replay rejection,
AES-256-GCM seal/open and tamper detection, recovery codes). `passkeys.ts` type-checks against
`@simplewebauthn/server` 14.0.2 (TypeScript 5.9 and 7.0); exercise it end to end in Playwright with a
virtual authenticator (CDP `WebAuthn.addVirtualAuthenticator`, see `e2e-testing`).

## TOTP, secret encryption, recovery codes (`mfa.ts`)

```ts
// mfa.ts - TOTP (otplib 13) with encrypted secrets and replay protection, plus hashed recovery codes.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';

// ---- secret encryption at rest (AES-256-GCM, key from a secret manager / env, 32 bytes base64) ----
export function sealer(keyB64: string) {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('MFA_ENC_KEY must be 32 bytes (base64)');
  return {
    seal(plain: string): string {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
    },
    open(sealed: string): string {
      const [v, iv, tag, body] = sealed.split('.');
      if (v !== 'v1' || !iv || !tag || !body) throw new Error('bad sealed value');
      // authTagLength pins the tag to 16 bytes: without it Node accepts truncated (4-byte) tags -> forgeable
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
    },
  };
}

// ---- TOTP ----
export function startTotpEnrollment(accountLabel: string, issuer: string) {
  const secret = generateSecret(); // base32, 20 bytes
  return { secret, uri: generateURI({ issuer, label: accountLabel, secret }) }; // render the URI as a QR code client-side
}

/**
 * Verify a 6-digit code. `lastStep` is the time step of the last accepted code for this user (persist it):
 * the same code cannot be replayed within its window. Returns the new step to store, or null.
 */
export async function verifyTotp(secret: string, code: string, lastStep: number | null): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const r = await verify({
    secret,
    token: code,
    epochTolerance: 30, // accept the previous/next 30 s step for clock drift
    ...(lastStep !== null && { afterTimeStep: lastStep }),
  });
  return r.valid && 'timeStep' in r ? r.timeStep : null; // narrow the TOTP|HOTP result union
}

// ---- recovery codes: high-entropy, shown once, stored as SHA-256, single use ----
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export function newRecoveryCodes(n = 10): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: n }, () => {
    const bytes = randomBytes(10);
    const s = [...bytes].map((b) => ALPHABET[b % 32]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { plain, hashes: plain.map(hashRecoveryCode) };
}
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
}
/** Constant-time lookup; the caller deletes the matched hash in the same transaction (single use). */
export function matchRecoveryCode(input: string, storedHashes: readonly string[]): string | null {
  const h = Buffer.from(hashRecoveryCode(input), 'hex');
  let found: string | null = null;
  for (const s of storedHashes) if (timingSafeEqual(h, Buffer.from(s, 'hex'))) found = s;
  return found;
}
```

Enrollment flow:
1. Require a recent re-auth. Generate the secret, keep it in a **pending** state server-side, show
   the QR code (render `uri` client-side; never send the secret to a third-party QR service).
2. The user enters a code; `verifyTotp()` succeeds -> store `sealer.seal(secret)` and the accepted
   step, generate recovery codes, show them once, mark MFA enabled, rotate the session.
3. Sign-in: password OK -> "MFA required" state (no full session yet) -> TOTP or recovery code ->
   rotate into a full session with `mfa: true`.

Persist per user: `totp_secret_sealed`, `totp_last_step`, and recovery codes (one row per code with
`used_at`). Consume a recovery code by deleting its row in the same transaction that creates the session.
Both writes must be conditional, or two parallel requests with the same code both pass: store the step
with `UPDATE ... SET totp_last_step = $step WHERE user_id = $1 AND (totp_last_step IS NULL OR
totp_last_step < $step)` and the recovery code with `DELETE ... WHERE user_id = $1 AND code_hash = $2`,
and accept only when exactly one row changed.
Each code carries 50 bits; plain SHA-256 is brute-forceable offline after a DB leak (hours on GPUs), so
for stronger at-rest protection use HMAC-SHA-256 with a server-side key (like `MFA_ENC_KEY`) instead.

## Passkeys (`passkeys.ts`, @simplewebauthn/server 14)

```ts
// passkeys.ts - WebAuthn registration and sign-in with @simplewebauthn/server 14 (browser: @simplewebauthn/browser 14).
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';

const rpID = process.env.WEBAUTHN_RP_ID ?? 'app.example.com'; // registrable domain, no scheme/port
const rpName = 'Example App';
const origin = process.env.WEBAUTHN_ORIGIN ?? 'https://app.example.com'; // exact origin(s) the browser reports

/** Persisted per credential (a user can have many). Store publicKey as bytes, id as base64url text. */
export interface StoredCredential extends WebAuthnCredential {
  userId: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** Challenges live server-side (session or a short-TTL table), one per ceremony, deleted when used. */
export interface ChallengeStore {
  put(key: string, challenge: string): Promise<void>; // TTL ~5 min
  take(key: string): Promise<string | null>; // returns once, then deletes
}

// ---- registration (user is already signed in; this adds a passkey) ----
export async function registrationOptions(user: { id: string; email: string }, existing: StoredCredential[], challenges: ChallengeStore) {
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.email,
    userID: new TextEncoder().encode(user.id), // opaque bytes, not the email
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })), // no duplicates on one device
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }, // discoverable = passkey
  });
  await challenges.put(`reg:${user.id}`, options.challenge);
  return options; // send as JSON; browser: startRegistration({ optionsJSON })
}

export async function finishRegistration(userId: string, response: RegistrationResponseJSON, challenges: ChallengeStore): Promise<StoredCredential> {
  const expectedChallenge = await challenges.take(`reg:${userId}`);
  if (!expectedChallenge) throw new Error('registration expired');
  const { verified, registrationInfo } = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
  });
  if (!verified || !registrationInfo) throw new Error('passkey not verified');
  const { credential } = registrationInfo;
  return { ...credential, userId, createdAt: new Date(), lastUsedAt: null }; // INSERT; unique on credential.id
}

// ---- sign-in (usernameless: the browser offers the user's passkeys) ----
export async function authenticationOptions(flowId: string, challenges: ChallengeStore) {
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
  await challenges.put(`auth:${flowId}`, options.challenge); // flowId: random id in a short-lived cookie
  return options; // browser: startAuthentication({ optionsJSON, useBrowserAutofill: true }) for conditional UI
}

export async function finishAuthentication(
  flowId: string,
  response: AuthenticationResponseJSON,
  challenges: ChallengeStore,
  findCredential: (id: string) => Promise<StoredCredential | null>,
): Promise<{ userId: string; newCounter: number; userVerified: boolean }> {
  const expectedChallenge = await challenges.take(`auth:${flowId}`);
  if (!expectedChallenge) throw new Error('sign-in expired');
  const credential = await findCredential(response.id);
  if (!credential) throw new Error('unknown passkey'); // same generic error to the client as a failed check
  const { verified, authenticationInfo } = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential,
    requireUserVerification: false,
  });
  if (!verified) throw new Error('passkey not verified');
  // persist authenticationInfo.newCounter and lastUsedAt; then create a fresh session for credential.userId.
  // userVerified=false (no PIN/biometric) is a single "possession" factor: do not set mfa: true / step-up
  // from it - or use userVerification: 'required' + requireUserVerification: true when passkeys replace password+MFA.
  return { userId: credential.userId, newCounter: authenticationInfo.newCounter, userVerified: authenticationInfo.userVerified };
}
```

Browser side (`@simplewebauthn/browser` 14):

```ts
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

const optionsJSON = await (await fetch('/auth/passkeys/register/options', { method: 'POST' })).json();
const attestation = await startRegistration({ optionsJSON });
await fetch('/auth/passkeys/register/verify', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(attestation),
});

// Sign-in with autofill ("conditional UI"): <input autocomplete="username webauthn">
const authOptions = await (await fetch('/auth/passkeys/login/options', { method: 'POST' })).json();
const assertion = await startAuthentication({ optionsJSON: authOptions, useBrowserAutofill: true });
```

Rules:
- `rpID` = the registrable domain the app runs on; passkeys do not move between domains. Decide it
  before launch.
- Unique index on the credential id; one user, many credentials; list and name them in settings.
- Removing the last passkey requires another factor to remain (or re-verification by email).
- Upgrading older code: v11 moved `startRegistration`/`startAuthentication` to a single options object;
  v13 renamed `AuthenticatorDevice` -> `WebAuthnCredential` (`credentialID` -> `id`,
  `credentialPublicKey` -> `publicKey`, `verifyAuthenticationResponse({ credential })`), retired
  `@simplewebauthn/types` (import types from server/browser) and removed `attestationType: 'indirect'`;
  v14 raised the supported runtime to Node 22 LTS (the `engines` field still says >= 20).
- Python: `webauthn` (py_webauthn 3.0) offers the same four functions
  (`generate_registration_options`, `verify_registration_response`, `generate_authentication_options`,
  `verify_authentication_response`) plus `options_to_json`.
