# Portfolio editor backend

Node.js service for the GitHub Pages portfolio. The editor is served by this service at `/edit/` so login cookies and write requests use one origin. It uses GitHub App installation credentials to read and commit `content.json`; the GitHub user authorization flow is only used to verify the editor's identity.

## Render settings

- Root Directory: `editor-server`
- Runtime: Node
- Build Command: `npm install` (or `npm ci` when a lockfile is present)
- Start Command: `npm start`
- Health Check Path: `/healthz`
- The server binds to `0.0.0.0` and `process.env.PORT`.

## Environment variables

Set these in the Render service Environment page. Never commit secrets to this repository.

| Variable | Required | Value |
| --- | --- | --- |
| `APP_ORIGIN` | Yes | Exact Render service origin, e.g. `https://portfolio-editor-xxxx.onrender.com` (no trailing slash) |
| `GITHUB_CALLBACK_URL` | Yes | `${APP_ORIGIN}/auth/github/callback`; must exactly match the GitHub App callback URL |
| `GITHUB_APP_ID` | Yes | GitHub App ID |
| `GITHUB_CLIENT_ID` | Yes | GitHub App Client ID |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub App client secret |
| `GITHUB_PRIVATE_KEY` | Yes | GitHub App private key PEM; multiline or `\n` escaped is supported |
| `GITHUB_INSTALLATION_ID` | Yes | Installation ID for the installation on the portfolio repository |
| `SESSION_SECRET` | Yes | Random secret of at least 32 bytes; used to sign short-lived session and OAuth state cookies |
| `ALLOWED_GITHUB_USER` | No | Allowed login; defaults to `faqihhhhh` |
| `GITHUB_OWNER` | No | Repository owner; defaults to `faqihhhhh` |
| `GITHUB_REPO` | No | Repository name; defaults to `faqihhhhh.github.io` |
| `GITHUB_BRANCH` | No | Branch to update; defaults to `main` |

The GitHub App needs repository **Contents: Read and write** permission and should be installed only on `faqihhhhh.github.io`. The editor creates a normal commit to the selected branch, which then triggers GitHub Pages publishing.

## Routes

- `GET /edit/`: editor UI
- `GET /auth/github`: starts GitHub authorization
- `GET /auth/github/callback`: verifies the GitHub account and creates an HTTP-only session cookie
- `GET /api/session`: current login state
- `GET /api/content`: reads `content.json` from GitHub (requires login)
- `PUT /api/content`: validates and commits content (requires login and same-origin request)
- `POST /auth/logout`: clears the session
- `GET /healthz`: Render health check

The access token from the login flow is not retained. Each content operation uses a short-lived installation token created from the GitHub App private key. The session cookie is signed, HTTP-only, secure, same-site, and expires after eight hours.
