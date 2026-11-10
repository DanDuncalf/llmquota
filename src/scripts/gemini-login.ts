// =============================================================================
// Gemini CLI — link a Google account for the quota dashboard
// =============================================================================
// Runs the same installed-app OAuth flow Gemini CLI uses, but without needing
// the CLI installed. Credentials are written in Gemini CLI's own format:
//
//   ~/.gemini-profiles/<slug>/.gemini/oauth_creds.json
//
// so the dashboard (and `GEMINI_CLI_HOME=<profile> gemini`) share one login.
//
// Usage:
//   npm run gemini-login -- second@example.com
//   npm run gemini-login -- you@example.com
//   npm run gemini-login -- --email me@gmail.com --no-open
//
// The browser opens; sign in with the requested Google account. The local
// callback server writes the tokens and exits.
// =============================================================================

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';

// Client IDs are public for installed apps. The accompanying "client secrets"
// are not confidential either, but GitHub's secret scanner flags them, so they
// live in .env instead of this repository.
const OAUTH_CLIENTS = {
  gemini: {
    id:
      process.env.GEMINI_OAUTH_CLIENT_ID ??
      '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    secret: process.env.GEMINI_OAUTH_CLIENT_SECRET,
    secretVar: 'GEMINI_OAUTH_CLIENT_SECRET',
  },
  antigravity: {
    id:
      process.env.ANTIGRAVITY_OAUTH_CLIENT_ID ??
      '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    secret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET,
    secretVar: 'ANTIGRAVITY_OAUTH_CLIENT_SECRET',
  },
} as const;

type ClientKind = keyof typeof OAUTH_CLIENTS;
const BASE_SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

// Antigravity CLI's own consent screen asks for these extra scopes; aicode is
// what actually authorizes model requests, openid supplies the id_token.
const ANTIGRAVITY_SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/aicode',
  'openid',
].join(' ');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TIMEOUT_MS = 10 * 60 * 1000;

const PROFILE_ROOT = process.env.GEMINI_PROFILE_ROOT ?? path.join(os.homedir(), '.gemini-profiles');

// -----------------------------------------------------------------------------
// Args
// -----------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const noOpen = flag('no-open') || process.env.NO_BROWSER === 'true';
// Gemini CLI's individual tier was retired; new links default to the client the
// same quota is still served to. `--gemini` forces the legacy client.
const clientKind: ClientKind = flag('gemini') ? 'gemini' : 'antigravity';
const oauth = OAUTH_CLIENTS[clientKind];
if (!oauth.secret) {
  console.error(
    `[gemini-login] ${oauth.secretVar} is not set — add the ${clientKind} installed-app ` +
      'OAuth client secret to .env (see .env.example), or set it in the environment.',
  );
  process.exit(1);
}
const oauthSecret: string = oauth.secret;
const oauthScope = clientKind === 'antigravity' ? ANTIGRAVITY_SCOPE : BASE_SCOPE;
const emailArgIdx = argv.findIndex((a) => a === '--email');
const expectedEmail =
  (emailArgIdx >= 0 ? argv[emailArgIdx + 1] : undefined) ??
  argv.find((a) => a.includes('@') && !a.startsWith('--'));

function slugFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  return (
    local
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'account'
  );
}

function jwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function openBrowser(url: string): void {
  if (noOpen) return;
  try {
    if (process.platform === 'win32') {
      // rundll32 receives the URL as a real argument — no cmd.exe `&` splitting.
      spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
        stdio: 'ignore',
        detached: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    /* the URL is printed anyway */
  }
}

function writeProfile(email: string, tokens: {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
  scope?: string;
  token_type?: string;
}): string {
  const home = path.join(PROFILE_ROOT, slugFromEmail(email));
  const geminiDir = path.join(home, '.gemini');
  fs.mkdirSync(geminiDir, { recursive: true });

  const credsPath = path.join(geminiDir, 'oauth_creds.json');
  const creds = {
    access_token: tokens.access_token,
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    expiry_date: Date.now() + tokens.expires_in * 1000,
    ...(tokens.id_token ? { id_token: tokens.id_token } : {}),
    scope: tokens.scope ?? oauthScope,
    token_type: tokens.token_type ?? 'Bearer',
  };

  if (fs.existsSync(credsPath) && !fs.existsSync(`${credsPath}.bak-quota-dashboard`)) {
    fs.copyFileSync(credsPath, `${credsPath}.bak-quota-dashboard`);
  }
  const tmp = `${credsPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, credsPath);

  fs.writeFileSync(
    path.join(home, 'profile.json'),
    JSON.stringify({ email, client: clientKind, linked_at: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );

  return home;
}

// -----------------------------------------------------------------------------
// OAuth flow
// -----------------------------------------------------------------------------
async function main(): Promise<void> {
  const state = crypto.randomBytes(32).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  let redirectUri = '';
  let settle: { resolve: () => void; reject: (e: Error) => void } | undefined;
  const done = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/oauth2callback') {
      res.writeHead(404).end('Not found');
      return;
    }

    const fail = (message: string): void => {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>Sign-in failed</h1><p>${message}</p><p>You can close this tab.</p>`);
      settle?.reject(new Error(message));
    };

    if (url.searchParams.get('error')) {
      fail(
        `${url.searchParams.get('error')}: ${url.searchParams.get('error_description') ?? ''}`,
      );
      return;
    }
    if (url.searchParams.get('state') !== state) {
      fail('OAuth state mismatch — please re-run the login command.');
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      fail('No authorization code returned by Google.');
      return;
    }

    try {
      const body = new URLSearchParams({
        code,
        client_id: oauth.id,
        client_secret: oauthSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      });
      const r = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`token exchange failed (HTTP ${r.status}): ${text.slice(0, 300)}`);
      const tokens = JSON.parse(text) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
        id_token?: string;
        scope?: string;
        token_type?: string;
      };

      let email = jwtPayload(tokens.id_token)?.email;
      if (typeof email !== 'string' || !email.includes('@')) {
        // Antigravity's token response may omit an ID token; ask userinfo.
        const info = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (info.ok) {
          const body = (await info.json()) as { email?: string };
          email = body.email;
        }
      }
      if (typeof email !== 'string' || !email.includes('@')) {
        throw new Error('Google did not return an email for this login.');
      }
      if (expectedEmail && email.toLowerCase() !== expectedEmail.toLowerCase()) {
        throw new Error(
          `signed in as ${email}, but ${expectedEmail} was expected — re-run and pick the right account`,
        );
      }

      const home = writeProfile(email, tokens);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<h1>Signed in as ${email}</h1><p>Credentials saved for the quota dashboard. You can close this tab.</p>`,
      );
      console.log(`\n[gemini-login] signed in as ${email} (${clientKind} client)`);
      console.log(`[gemini-login] profile: ${home}`);
      console.log('[gemini-login] the dashboard will pick it up on the next scrape.');
      settle?.resolve();
    } catch (err) {
      fail((err as Error).message);
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      settle?.reject(new Error('could not open the local OAuth callback port'));
      return;
    }
    redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;

    const authUrl = new URL(AUTH_URL);
    authUrl.searchParams.set('client_id', oauth.id);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', oauthScope);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    if (expectedEmail) authUrl.searchParams.set('login_hint', expectedEmail);

    console.log(`[gemini-login] linking ${expectedEmail ?? 'a Google account'} (${clientKind} client)`);
    console.log('\nOpen this URL and sign in:\n');
    console.log(authUrl.toString());
    console.log('');
    openBrowser(authUrl.toString());
    console.log('[gemini-login] waiting for the Google callback… (Ctrl+C to cancel)');
  });

  const timer = setTimeout(() => {
    settle?.reject(new Error('timed out after 10 minutes'));
  }, TIMEOUT_MS);

  try {
    await done;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

main().catch((err) => {
  console.error('[gemini-login]', (err as Error).message);
  process.exit(1);
});
