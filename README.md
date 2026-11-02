# Chatter

Chatter is a chat application served by Node.js. It uses Supabase PostgreSQL for accounts, contacts, conversations, groups, messages, and activity, and server-sent events to deliver chat updates to connected browsers.

## Requirements

- Node.js 22.13 or newer (Node 24 recommended)
- npm

## Run locally

1. Create a Supabase project and run `supabase-schema.sql` in the Supabase SQL Editor.
2. Set `SUPABASE_PROJECT_ID` and `SUPABASE_SERVICE_ROLE_KEY` on the server.
3. Configure the Brevo variables described below to enable account registration.
4. Open a terminal in this project folder and run `npm start`.
5. Open `http://localhost:3000`.
6. Register two accounts in separate browser profiles to try real messaging. Add the second account using its registered phone number.

Before starting Chatter, create a Supabase project and run [`supabase-schema.sql`](./supabase-schema.sql) in its SQL Editor. Configure `SUPABASE_PROJECT_ID` and `SUPABASE_SERVICE_ROLE_KEY` on the server. Chatter calls private Supabase database RPC functions through the server-side REST API; the service-role key is never sent to browsers. The schema enables row-level security without public table policies and grants the database RPC functions only to the `service_role`. Passwords are hashed before storage. The HTTP-only session cookie uses `SameSite=Strict`; signing in remains active across page refreshes and server restarts, and sessions expire after 7 days without activity or when you log out.

## Profile photos, chat photos, and chat links

Registration requires a valid Nigerian phone number. The contact form includes a bundled list of 245 country and territory calling codes from `libphonenumber-js`; the list works without an API request. Users can choose a JPEG, PNG, or WebP profile photo (up to 5 MB), send those images in conversations, and copy a personal chat link from Settings. Opening a chat link requires a Chatter account and sign-in; it does not expose the sender's email or phone number. Anyone with the link can start a conversation, so share it only with people you want to contact you.

Run the updated `supabase-schema.sql` in the Supabase SQL Editor to add the profile and message image fields and create the private `chatter-media` Storage bucket. This is safe to run on an existing Chatter database; existing accounts receive private chat-link tokens automatically. Image access is served through the authenticated Node.js server, not a public Storage bucket. Moderators can view an image only when its message is reported, and image views are written to the moderation audit log.

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

## Selling foreign Chatter numbers

Users register with a valid Nigerian (+234) phone number. In Settings, they can subscribe to an available foreign Chatter number for **₦10,000 per month**. Paystack handles automatic monthly recurring charges. After payment is verified, the number is held exclusively for that customer and shown as awaiting approval. It does not become an active Chatter contact number until a moderator approves it; only then can other Chatter users find the customer with that number. Customers can cancel future renewals in Settings. A cancelled active number remains assigned through its paid period.

In the moderation console, open **Phone numbers** to review paid requests. Approving activates the number for its buyer. To reject a paid request, first issue the refund in Paystack, then use **Reject**; Chatter disables recurring billing and releases the number. The refund itself is manual and must be completed before confirming rejection.

This feature does not create phone numbers or enable real calls/SMS. Add only numbers that you have lawfully obtained from a carrier. The foreign number works as a Chatter contact identifier only; external calls and SMS still require a connected telecom provider. The app’s existing calls are browser-to-browser WebRTC calls.

Before deploying the new feature, run the updated `supabase-schema.sql` in the Supabase SQL Editor. It creates or migrates the private inventory, subscription, and payment tables, including the customer-owned reservation and pending-approval status. In the live Paystack dashboard, create a **monthly NGN plan for ₦10,000** and configure its webhook URL as:

```text
https://YOUR-RENDER-SERVICE.onrender.com/api/paystack/webhook
```

In Render → your service → Environment, add these values as private environment variables:

```text
PAYSTACK_SECRET_KEY=sk_live_your_live_secret_key
PAYSTACK_PLAN_CODE=PLN_your_monthly_plan_code
CHATTER_PUBLIC_URL=https://YOUR-RENDER-SERVICE.onrender.com
```

Use the secret key and plan code from the same **live** Paystack account. Keep the secret key only in Render; never put it in browser code, GitHub, or chat. The existing `SUPABASE_PROJECT_ID`, `SUPABASE_SERVICE_ROLE_KEY`, Brevo variables, and moderator password must also remain configured in Render. After deploying and running the schema, sign in at `/moderation.html`, open **Phone numbers**, choose the country from the calling-code dropdown, and enter only the national digits. The dropdown lists valid national-number lengths, and the server validates the selected country and full number. Only available, unassigned numbers can be removed.

Enable Paystack's `charge.success`, `subscription.create`, `subscription.not_renew`, `subscription.disable`, and `invoice.payment_failed` webhook events so payments, renewals, failures, and cancellations update Chatter.

Paystack must support NGN recurring subscriptions for your merchant account. Check that the plan is active and that the account is approved for live payments before accepting customers. Do not enter a customer's live payment details yourself.

## Disclosed moderation

The admin console includes account details, activity metadata, call participants/outcomes, system health, reported messages, and a moderation audit log. The User activity view can filter by account name, email, or phone; the Users directory also has a per-account activity link. Activity entries cover recorded actions such as account creation, sign-ins, contact and profile changes, groups created, messages sent, reports, conversation clearing, and call outcomes. The view paginates through matching entries. Activity logging is forward-looking and does not backfill actions from before it was enabled. It records action types and timestamps, not message text, chat viewing, attachment contents, conversation contents, or call media. The registration and login screens disclose this collection. Moderators can review a message only after a user reports it; reported image views, admin sign-ins, report views, and moderation actions are recorded in an audit log.

Configure a strong moderator password of at least 20 characters before starting the server:

```powershell
$env:CHATTER_MODERATOR_PASSWORD = "use-a-long-unique-secret-of-your-own"
npm.cmd start
```

Open `http://localhost:3000/moderation.html` and sign in with that password. Keep the password private and do not commit it to source control. If it is not configured, moderator sign-in stays disabled.

This local setup does not send SMS verification codes or upload file contents. Before deploying publicly, add rate limiting and database backups.

## Render deployment

The GitHub Pages URL serves static files only; it cannot run this Node.js server or real-time calls. Deploy Chatter as a Render Web Service connected to this repository, with the build command `npm install` and start command `npm start`. First create a Supabase project and run `supabase-schema.sql` in its SQL Editor.

Configure these Render environment variables:

- `HOST=0.0.0.0`
- `NODE_ENV=production`
- `SUPABASE_PROJECT_ID` set to the project reference from the Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` set to the project service-role key (server-side secret)
- `CHATTER_MODERATOR_PASSWORD` set through Render's secret environment-variable settings to a unique password of at least 20 characters
- `CHATTER_ICE_SERVERS` with your production STUN/TURN configuration; TURN is needed for reliable calls across restrictive networks
- `BREVO_API_KEY` and `BREVO_SENDER_EMAIL` for verified registration and welcome emails
- `CHATTER_PUBLIC_URL` set to the HTTPS URL Render assigns to the deployed service, for the welcome-email button

Chatter stores data in Supabase PostgreSQL; it does not need a Render disk for the database. Existing SQLite data is not automatically imported—this Supabase setup starts fresh. Never add production secrets to GitHub or browser code.

The Supabase schema enables row-level security and defines no public table access policies. The app uses `SUPABASE_SERVICE_ROLE_KEY` only from its Node.js server; never put it in frontend code, GitHub, or a public environment variable. Configure database backups and rate limiting, and test registration, login, calls, and moderation on the deployed HTTPS URL. HTTPS is required for browser camera and microphone access. Render serves the Node.js app at its own URL; the GitHub Pages link is not the live backend.
