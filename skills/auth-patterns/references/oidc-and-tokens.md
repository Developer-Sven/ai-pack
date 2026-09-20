# OIDC login and tokens

`oidc.ts` and `jwt.ts` type-check against openid-client 6.8.8 and jose 6.2.12; `jwt.ts` is exercised
by the test suite in `sessions-and-passwords.md` (valid token, missing subject, wrong audience,
`alg: none`).

## Sign in with an OIDC provider (`oidc.ts`)

```ts
// oidc.ts - "Sign in with <provider>" via OIDC authorization code + PKCE + state + nonce (openid-client 6).
import * as client from 'openid-client';
import { sealer } from './mfa.ts';

const ISSUER = new URL(process.env.OIDC_ISSUER!); // e.g. https://accounts.google.com
const REDIRECT_URI = process.env.OIDC_REDIRECT_URI!; // exact match with the provider registration
const box = sealer(process.env.COOKIE_ENC_KEY!); // 32 random bytes, base64
const PENDING_COOKIE = '__Host-oidc';

let config: client.Configuration | undefined;
async function getConfig(): Promise<client.Configuration> {
  // Discovery once per process: endpoints, JWKS, supported algorithms come from the issuer metadata.
  config ??= await client.discovery(ISSUER, process.env.OIDC_CLIENT_ID!, process.env.OIDC_CLIENT_SECRET!);
  return config;
}

/** GET /auth/oidc/start -> 302 to the provider. */
export async function beginLogin(): Promise<{ location: string; setCookie: string }> {
  const codeVerifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(await getConfig(), {
    redirect_uri: REDIRECT_URI,
    scope: 'openid email profile',
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  const pending = box.seal(JSON.stringify({ codeVerifier, state, nonce, exp: Date.now() + 10 * 60_000 }));
  // Lax is enough: the provider returns via a top-level GET. With response_mode=form_post use SameSite=None.
  return { location: url.href, setCookie: `${PENDING_COOKIE}=${pending}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600` };
}

export interface ExternalIdentity {
  issuer: string;
  subject: string; // stable id at the provider: key accounts by (issuer, subject), never by email alone
  email: string | null;
  emailVerified: boolean;
}

/** GET /auth/oidc/callback?code=...&state=... */
export async function finishLogin(currentUrl: URL, pendingCookie: string | undefined): Promise<ExternalIdentity> {
  if (!pendingCookie) throw new Error('login expired, start again');
  const p = JSON.parse(box.open(pendingCookie)) as { codeVerifier: string; state: string; nonce: string; exp: number };
  if (Date.now() > p.exp) throw new Error('login expired, start again');
  const tokens = await client.authorizationCodeGrant(await getConfig(), currentUrl, {
    pkceCodeVerifier: p.codeVerifier,
    expectedState: p.state, // CSRF on the callback
    expectedNonce: p.nonce, // ID token replay
    idTokenExpected: true,
  });
  const claims = tokens.claims(); // signature, iss, aud, exp, iat, nonce already validated
  if (!claims) throw new Error('no id_token');
  return {
    issuer: claims.iss,
    subject: claims.sub,
    email: typeof claims.email === 'string' ? claims.email.toLowerCase() : null,
    emailVerified: claims.email_verified === true,
  };
  // Next: find user by (issuer, subject); create or link; then sessions.create(user.id) - rotate, clear the pending cookie.
}
```

Wiring (Express 5 style):

```ts
app.get('/auth/oidc/start', async (_req, res) => {
  const { location, setCookie } = await beginLogin();
  res.setHeader('Set-Cookie', setCookie).redirect(302, location);
});
app.get('/auth/oidc/callback', async (req, res) => {
  const current = new URL(req.originalUrl, process.env.PUBLIC_ORIGIN); // fixed origin, not the Host header
  const identity = await finishLogin(current, req.cookies['__Host-oidc']);
  const user = await users.findOrCreateByIdentity(identity); // unique index on (issuer, subject)
  const { cookie } = sessions.create(user.id);
  res
    .setHeader('Set-Cookie', [cookie, '__Host-oidc=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'])
    .redirect(303, '/'); // a returnTo must travel inside the sealed pending cookie (the callback URL is fixed),
                         // then be checked against allow-listed internal paths before redirecting
});
```

Account-linking policy (write it down):
- Existing `(issuer, subject)` -> that user.
- New identity whose email matches an existing account: link **only** if `emailVerified` is true
  **and** the existing account proves ownership (currently signed in, or confirms an emailed link).
  Otherwise ask the user to sign in with the existing method first.
- Keep identities in their own table (`user_identities(user_id, issuer, subject, email, created_at)`)
  so one user can have Google + GitHub + password.

Python: `authlib` (`authlib.integrations.starlette_client.OAuth`) implements the same flow with PKCE
(`code_challenge_method='S256'`) and nonce validation for FastAPI/Starlette.

## Verifying JWT access tokens (`jwt.ts`)

```ts
// jwt.ts - only when a JWT is justified (service-to-service, third-party API tokens). Verify strictly.
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';

const ISSUER = process.env.JWT_ISSUER ?? 'https://auth.example.com';
const AUDIENCE = process.env.JWT_AUDIENCE ?? 'api://orders';
// Remote JWKS: keys are cached and refreshed on unknown `kid`; rotation needs no deploy.
// Take the URL from the issuer's discovery document (`jwks_uri`); the path differs per IdP (Keycloak: /protocol/openid-connect/certs).
const JWKS = createRemoteJWKSet(new URL(process.env.JWT_JWKS_URI ?? `${ISSUER}/.well-known/jwks.json`));

export async function verifyAccessToken(token: string, keys: Parameters<typeof jwtVerify>[1] = JWKS): Promise<JWTPayload & { sub: string }> {
  const { payload } = await jwtVerify(token, keys, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['ES256', 'EdDSA', 'RS256'], // allow-list: never 'none', never "whatever the header says"
    maxTokenAge: '15m', // with iat: rejects old tokens even if exp is far away
    clockTolerance: '30s',
  });
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('token without subject');
  return payload as JWTPayload & { sub: string };
}
```

## Refresh tokens (when you issue your own)

- Opaque random value (32 bytes), stored hashed with `family_id`, `user_id`, `expires_at`, `used_at`.
- On refresh: a conditional UPDATE marks the presented token used (single use); issue a new one in the
  same family. If an **already used** token is presented again, revoke the whole family (theft) and
  force re-login.
- Absolute family lifetime (e.g. 30 days); revoke families on logout and password change.
- Browser clients get refresh tokens in an `HttpOnly` cookie scoped to the refresh path; native apps
  keep them in the OS keychain.

## Service-to-service

Prefer platform identity (mTLS, workload identity, cloud IAM) over shared secrets. If you mint JWTs:
one audience per service, 5-minute lifetime, asymmetric keys (ES256/EdDSA) published as JWKS, key
rotation with overlapping `kid`s.
