# Chatter

Chatter is a chat application served by Node.js. The server uses SQLite for accounts, contacts, conversations, groups, and messages, and server-sent events to deliver chat updates to connected browsers.

## Requirements

- Node.js 22.13 or newer (Node 24 recommended)
- npm

## Run locally

1. Open a terminal in this project folder.
2. Run `npm start`.
3. Open `http://localhost:3000`.
4. Register two accounts in separate browser profiles to try real messaging. Add the second account using its registered phone number.

The SQLite database is created at `data/chatter.sqlite` the first time the server starts. Keep the `data` directory to preserve accounts, messages, and sign-in sessions. Passwords are hashed before storage. The HTTP-only session cookie uses `SameSite=Strict`; signing in remains active across page refreshes and server restarts, and sessions expire after 7 days without activity or when you log out.

## Brevo email verification

New accounts must verify their email before they are created. Chatter sends a six-digit verification code through Brevo, expires codes after 10 minutes, limits each code to five attempts, and waits 60 seconds before sending another code to the same address. After successful verification, Chatter creates the account and sends a branded welcome email. A welcome-email delivery problem does not prevent sign-in after the account has been created.

In Brevo, create a v3 API key and verify the sender email address (or authenticate its domain). Configure these server environment variables before starting Chatter:

```powershell
$env:BREVO_API_KEY = "your-brevo-api-v3-key"
$env:BREVO_SENDER_EMAIL = "hello@your-verified-domain.com"
$env:BREVO_SENDER_NAME = "Chatter"
$env:CHATTER_PUBLIC_URL = "https://your-service.onrender.com"
npm.cmd start
```

`BREVO_SENDER_NAME` and `CHATTER_PUBLIC_URL` are optional; the sender name defaults to `Chatter`, and the welcome email includes an app button only when a public URL is configured. Keep the API key in server environment settings, never in browser code or GitHub. Registration is unavailable until `BREVO_API_KEY` and `BREVO_SENDER_EMAIL` are configured.

## Audio and video calls

Users can start audio or video calls from a one-to-one conversation. The other person must be signed in with Chatter open to receive and answer the call. Allow microphone and camera access when the browser asks. Calls use WebRTC to send media between the two browsers; screen sharing is available during video calls.

Call entries are saved in the conversation. Both users can see whether a call was answered, declined, missed, or how long an answered call lasted.

For local development, open Chatter at `http://localhost:3000` in two separate browser profiles. Do not open `index.html` directly as a `file://` page. For calls between different devices or over the internet, host Chatter behind HTTPS so browsers allow camera and microphone access. The default public STUN server helps establish direct connections, but some networks require a TURN relay. Configure your TURN provider's ICE server settings before deployment; browsers receive these settings through the authenticated call setup endpoint:

```powershell
$env:CHATTER_ICE_SERVERS = '[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.net:3478","username":"your-turn-username","credential":"your-turn-credential"}]'
npm.cmd start
```

Use your TURN provider's actual address and credentials, keep credentials out of source control, and prefer short-lived TURN credentials. Calls cannot ring users whose Chatter app is closed, and this local development server is not itself an internet hosting setup.

## Disclosed moderation

The admin console includes account details, activity metadata, call participants/outcomes, system health, reported messages, and a moderation audit log. The User activity view can filter by account name, email, or phone; the Users directory also has a per-account activity link. Activity entries cover recorded actions such as account creation, sign-ins, contact and profile changes, groups created, messages sent, reports, conversation clearing, and call outcomes. The view paginates through matching entries. Activity logging is forward-looking and does not backfill actions from before it was enabled. It records action types and timestamps, not message text, chat viewing, attachment contents, conversation contents, or call media. The registration and login screens disclose this collection. Moderators can review a message only after a user reports it; admin sign-ins, report views, and moderation actions are recorded in an audit log.

Configure a strong moderator password of at least 20 characters before starting the server:

```powershell
$env:CHATTER_MODERATOR_PASSWORD = "use-a-long-unique-secret-of-your-own"
npm.cmd start
```

Open `http://localhost:3000/moderation.html` and sign in with that password. Keep the password private and do not commit it to source control. If it is not configured, moderator sign-in stays disabled.

This local setup does not send SMS verification codes or upload file contents. It is not configured for public internet hosting. Before deploying publicly, add rate limiting, backups, and a production hosting setup.

## Render deployment

The GitHub Pages URL serves static files only; it cannot run this Node.js server, SQLite database, or real-time calls. Deploy Chatter as a Render Web Service connected to this repository, with the build command `npm install` and start command `npm start`.

Configure these Render environment variables:

- `HOST=0.0.0.0`
- `NODE_ENV=production`
- `CHATTER_DATA_DIR=/var/data`
- `CHATTER_MODERATOR_PASSWORD` set through Render's secret environment-variable settings to a unique password of at least 20 characters
- `CHATTER_ICE_SERVERS` with your production STUN/TURN configuration; TURN is needed for reliable calls across restrictive networks
- `BREVO_API_KEY` and `BREVO_SENDER_EMAIL` for verified registration and welcome emails
- `CHATTER_PUBLIC_URL` set to the HTTPS URL Render assigns to the deployed service, for the welcome-email button

Attach a persistent Render disk mounted at `/var/data`. SQLite stores accounts, messages, reports, call history, and sessions there; without persistent storage those records can be lost when the service restarts or redeploys. Persistent disks and plan availability can affect hosting cost, so choose the Render plan and storage size before creating the service. Never add production secrets or database files to GitHub.

Before sharing the public service, configure backups and rate limiting, and test registration, login, calls, and moderation on the deployed HTTPS URL. HTTPS is required for browser camera and microphone access. Render serves the Node.js app at its own URL; the GitHub Pages link is not the live backend.
