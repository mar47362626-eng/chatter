const { createHash, createHmac, randomBytes, randomInt, scrypt: scryptCallback, timingSafeEqual } = require("node:crypto");
const { parseEnv, promisify } = require("node:util");
const { createServer } = require("node:http");
const { existsSync, readFileSync, statSync } = require("node:fs");
const { extname, join, normalize } = require("node:path");
const { getCountries, getCountryCallingCode, isValidPhoneNumber, parsePhoneNumber } = require("libphonenumber-js");
const phoneMetadata = require("libphonenumber-js/metadata.max.json");
const webPush = require("web-push");

const scrypt = promisify(scryptCallback);
const root = __dirname;
const envFile = join(root, ".env");
if (existsSync(envFile)) {
  Object.assign(process.env, parseEnv(readFileSync(envFile, "utf8")));
}
const supabaseProjectId = process.env.SUPABASE_PROJECT_ID;
const supabaseUrl = process.env.SUPABASE_URL || (supabaseProjectId ? `https://${supabaseProjectId}.supabase.co` : "");
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("Set SUPABASE_PROJECT_ID and SUPABASE_SERVICE_ROLE_KEY for the server-side Supabase API.");
}
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl)) {
  throw new Error("SUPABASE_URL must be a Supabase HTTPS project URL.");
}
async function callSupabaseRpc(functionName, body) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
    method: "POST",
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const responseText = await response.text();
    let responseError;
    try {
      const payload = JSON.parse(responseText);
      responseError = [payload.code, payload.message, payload.hint].filter(Boolean).join(": ");
    } catch {
      responseError = "";
    }
    const error = new Error(
      `Supabase RPC ${functionName} failed with HTTP ${response.status}${responseError ? `: ${responseError}` : "."}`
    );
    if (response.status === 409) error.code = "23505";
    throw error;
  }
  return response.json();
}
function postgresSql(sql) {
  let parameterIndex = 0;
  return sql
    .replace(/\?/g, () => `$${++parameterIndex}`)
    .replace(/\$(\d+) IS NULL/g, "($$$1::text) IS NULL")
    .replace(/ COLLATE NOCASE/g, "")
    .replace(/\bAS\s+([a-z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*)/g, 'AS "$1"')
    .replace(/\bLIKE\b/g, "ILIKE");
}
const database = {
  prepare(sql) {
    const text = postgresSql(sql);
    return {
      async get(...values) {
        const result = await callSupabaseRpc("chatter_query", { p_statement: text, p_parameters: values });
        return result.rows[0];
      },
      async all(...values) {
        const result = await callSupabaseRpc("chatter_query", { p_statement: text, p_parameters: values });
        return result.rows;
      },
      async run(...values) {
        const result = await callSupabaseRpc("chatter_query", { p_statement: text, p_parameters: values });
        return { changes: result.rowCount };
      }
    };
  },
  async transaction(callback) {
    const statements = [];
    const transactionDatabase = {
      prepare(sql) {
        const text = postgresSql(sql);
        return {
          async run(...values) {
            statements.push({ statement: text, parameters: values });
            return { changes: 1 };
          }
        };
      }
    };
    const result = await callback(transactionDatabase);
    if (statements.length) await callSupabaseRpc("chatter_batch", { p_statements: statements });
    return result;
  }
};
const secureCookieAttribute = process.env.NODE_ENV === "production" ? "; Secure" : "";
const sessions = new Map();
const eventStreams = new Map();
const calls = new Map();
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const verificationCodeLifetime = 10 * 60 * 1000;
const verificationResendDelay = 60 * 1000;
const maxVerificationAttempts = 5;
const callRingLifetime = 60 * 1000;
const callLifetime = 4 * 60 * 60 * 1000;
const maxRequestBytes = 1024 * 1024;
const maxImageBytes = 5 * 1024 * 1024;
const mediaBucket = "chatter-media";
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || "";
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || "";
const vapidSubject = process.env.VAPID_SUBJECT || "";
if (Boolean(vapidPublicKey) !== Boolean(vapidPrivateKey) || (vapidPublicKey && !vapidSubject)) {
  throw new Error("Configure VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT together to enable push notifications.");
}
if (vapidPublicKey) {
  try {
    webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  } catch (error) {
    throw new Error("VAPID push notification configuration is invalid.", { cause: error });
  }
}
const numberSubscriptionAmount = 1000000;
const numberSubscriptionCurrency = "NGN";
const moderatorPassword = process.env.CHATTER_MODERATOR_PASSWORD || "";
const moderatorPasswordHash = createHash("sha256").update(moderatorPassword).digest();
let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
if (process.env.CHATTER_ICE_SERVERS) {
  try {
    iceServers = JSON.parse(process.env.CHATTER_ICE_SERVERS);
  } catch (error) {
    throw new Error("CHATTER_ICE_SERVERS must be valid JSON.", { cause: error });
  }
  if (!Array.isArray(iceServers) || !iceServers.length || iceServers.some((server) =>
    !server || typeof server !== "object" || !(typeof server.urls === "string" || Array.isArray(server.urls))
  )) {
    throw new Error("CHATTER_ICE_SERVERS must be a non-empty JSON array of ICE server objects.");
  }
}
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function respond(response, status, value, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const [key, ...value] = part.trim().split("=");
    return [key, decodeURIComponent(value.join("="))];
  }).filter(([key]) => key));
}

async function readJson(request, maxBytes = maxRequestBytes) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBytes) throw new HttpError(413, "Request is too large.");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

async function readRawBody(request, maxBytes = maxRequestBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "Request is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function cleanText(value, label, maxLength) {
  if (typeof value !== "string") throw new HttpError(400, `${label} is required.`);
  const cleaned = value.trim();
  if (cleaned.length > maxLength) throw new HttpError(400, `${label} must be ${maxLength} characters or fewer.`);
  return cleaned;
}

function normalizePhone(value) {
  const phone = typeof value === "string" ? value.trim() : "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) throw new HttpError(400, "Enter a valid phone number with 7 to 15 digits.");
  return `+${digits}`;
}

function requireNigerianPhone(phone) {
  if (!phone.startsWith("+234") || !isValidPhoneNumber(phone, "NG")) {
    throw new HttpError(400, "Use a Nigerian phone number beginning with +234 to register or update your account.");
  }
  return phone;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    chatterNumber: user.chatter_phone || user.phone,
    avatarUrl: user.avatar_path ? `/api/avatars/${user.id}` : "",
    shareToken: user.share_token
  };
}

async function getPublicUser(userId) {
  return database.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.avatar_path, u.share_token,
      assigned.phone AS chatter_phone
    FROM users u
    LEFT JOIN number_subscriptions ns
      ON ns.user_id = u.id AND ns.status = 'active'
      AND (ns.next_payment_at IS NULL OR ns.next_payment_at > now())
    LEFT JOIN foreign_numbers assigned
      ON assigned.id = ns.number_id AND assigned.assigned_user_id = u.id
    WHERE u.id = ?
  `).get(userId);
}

function imagePayload(input) {
  if (!input || typeof input !== "object") throw new HttpError(400, "Choose an image to upload.");
  const mimeType = input.type;
  const base64 = input.data;
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType) || typeof base64 !== "string") {
    throw new HttpError(400, "Choose a JPEG, PNG, or WebP image.");
  }
  if (base64.length > Math.ceil(maxImageBytes / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new HttpError(413, "Images must be 5 MB or smaller.");
  }
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.length > maxImageBytes || bytes.toString("base64") !== base64) {
    throw new HttpError(413, "Images must be 5 MB or smaller.");
  }
  const isJpeg = mimeType === "image/jpeg" && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = mimeType === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isWebp = mimeType === "image/webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!isJpeg && !isPng && !isWebp) throw new HttpError(400, "The selected file is not a valid JPEG, PNG, or WebP image.");
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
  return { bytes, mimeType, extension };
}

function imageSize(bytes) {
  return bytes.length < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes.length / 1024))} KB`
    : `${(bytes.length / (1024 * 1024)).toFixed(1)} MB`;
}

function storageObjectUrl(path) {
  return `${supabaseUrl}/storage/v1/object/${mediaBucket}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function uploadMediaObject(path, bytes, mimeType, upsert = false) {
  const result = await fetch(storageObjectUrl(path), {
    method: "POST",
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      "Content-Type": mimeType,
      "x-upsert": String(upsert)
    },
    body: bytes
  });
  if (!result.ok) {
    const details = await result.text();
    console.error("Supabase image upload failed:", result.status, details);
    throw new HttpError(502, "Image storage is unavailable. Please try again.");
  }
}

async function removeMediaObject(path) {
  const result = await fetch(storageObjectUrl(path), {
    method: "DELETE",
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`
    }
  });
  if (!result.ok) {
    const details = await result.text();
    console.error("Supabase image cleanup failed:", result.status, details);
  }
}

async function readMediaObject(path) {
  const result = await fetch(`${supabaseUrl}/storage/v1/object/authenticated/${mediaBucket}/${path.split("/").map(encodeURIComponent).join("/")}`, {
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`
    }
  });
  if (!result.ok) {
    const details = await result.text();
    console.error("Supabase image read failed:", result.status, details);
    throw new HttpError(result.status === 404 ? 404 : 502, result.status === 404 ? "Image not found." : "Image storage is unavailable.");
  }
  return Buffer.from(await result.arrayBuffer());
}

function avatarUrl(userId, avatarPath) {
  return avatarPath ? `/api/avatars/${userId}` : "";
}

async function servePrivateImage(response, path, mimeType) {
  const bytes = await readMediaObject(path);
  response.writeHead(200, {
    "Content-Type": mimeType,
    "Content-Length": bytes.length,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin"
  });
  response.end(bytes);
}

function countryCallingCodes() {
  const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
  return getCountries().map((country) => ({
    country,
    name: displayNames.of(country) || country,
    callingCode: `+${getCountryCallingCode(country)}`,
    nationalNumberLengths: phoneMetadata.countries[country][3]
  })).sort((left, right) => left.name.localeCompare(right.name));
}

function escapeEmailHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character]);
}

function verificationCodeHash(email, code) {
  return createHmac("sha256", process.env.BREVO_API_KEY).update(`chatter-email-verification:${email}:${code}`).digest("hex");
}

function verificationEmail(name, code) {
  const safeName = escapeEmailHtml(name);
  const html = `
    <!doctype html>
    <html lang="en">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="margin:0;padding:32px 12px;background:#f4f7f5;font-family:Arial,Helvetica,sans-serif;color:#203128">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;border-collapse:collapse">
          <tr><td style="padding:0 0 18px;text-align:center;font-size:23px;font-weight:700;letter-spacing:-1px;color:#203128">chatter<span style="color:#1c9a70">.</span></td></tr>
          <tr><td style="padding:34px 32px 30px;border-radius:18px;background:#fff;border:1px solid #e5ece7">
            <p style="margin:0 0 10px;color:#1c9a70;font-size:11px;font-weight:700;letter-spacing:1.5px">ONE QUICK CHECK</p>
            <h1 style="margin:0 0 12px;font-size:25px;line-height:1.25;color:#203128">Verify your email</h1>
            <p style="margin:0;color:#6d7d73;font-size:15px;line-height:1.7">Hi ${safeName}, enter this code in Chatter to finish creating your account.</p>
            <div style="margin:26px 0;padding:19px 12px;border:1px solid #dcece3;border-radius:12px;background:#f4faf6;text-align:center">
              <span style="color:#177d5c;font-size:32px;font-weight:700;letter-spacing:10px">${code}</span>
            </div>
            <p style="margin:0;color:#6d7d73;font-size:13px;line-height:1.7">This code expires in <strong>10 minutes</strong>. If you did not request it, you can safely ignore this email.</p>
          </td></tr>
          <tr><td style="padding:18px 12px 0;color:#94a198;text-align:center;font-size:11px;line-height:1.6">A little closer, wherever you are.<br>© Chatter</td></tr>
        </table>
      </body>
    </html>
  `;
  return {
    subject: "Your Chatter verification code",
    html,
    text: `Hi ${name},\n\nUse this code to finish creating your Chatter account: ${code}\n\nIt expires in 10 minutes. If you did not request it, ignore this email.\n\nA little closer, wherever you are.\nChatter`
  };
}

function profileVerificationCodeHash(userId, email, code) {
  return createHmac("sha256", process.env.BREVO_API_KEY)
    .update(`chatter-profile-verification:${userId}:${email}:${code}`)
    .digest("hex");
}

function profileVerificationEmail(name, code) {
  const safeName = escapeEmailHtml(name);
  const html = `
    <!doctype html>
    <html lang="en">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="margin:0;padding:32px 12px;background:#f4f7f5;font-family:Arial,Helvetica,sans-serif;color:#203128">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;border-collapse:collapse">
          <tr><td style="padding:0 0 18px;text-align:center;font-size:23px;font-weight:700;letter-spacing:-1px;color:#203128">chatter<span style="color:#1c9a70">.</span></td></tr>
          <tr><td style="padding:34px 32px 30px;border-radius:18px;background:#fff;border:1px solid #e5ece7">
            <p style="margin:0 0 10px;color:#1c9a70;font-size:11px;font-weight:700;letter-spacing:1.5px">ACCOUNT DETAILS</p>
            <h1 style="margin:0 0 12px;font-size:25px;line-height:1.25;color:#203128">Confirm your changes</h1>
            <p style="margin:0;color:#6d7d73;font-size:15px;line-height:1.7">Hi ${safeName}, enter this code in Chatter to save your account details.</p>
            <div style="margin:26px 0;padding:19px 12px;border:1px solid #dcece3;border-radius:12px;background:#f4faf6;text-align:center">
              <span style="color:#177d5c;font-size:32px;font-weight:700;letter-spacing:10px">${code}</span>
            </div>
            <p style="margin:0;color:#6d7d73;font-size:13px;line-height:1.7">This code expires in <strong>10 minutes</strong>. If you did not request this change, you can safely ignore this email.</p>
          </td></tr>
          <tr><td style="padding:18px 12px 0;color:#94a198;text-align:center;font-size:11px;line-height:1.6">A little closer, wherever you are.<br>© Chatter</td></tr>
        </table>
      </body>
    </html>
  `;
  return {
    subject: "Confirm your Chatter account changes",
    html,
    text: `Hi ${name},\n\nUse this code to save your Chatter account details: ${code}\n\nIt expires in 10 minutes. If you did not request this change, ignore this email.\n\nA little closer, wherever you are.\nChatter`
  };
}

function getPublicUrl() {
  const configuredUrl = process.env.CHATTER_PUBLIC_URL;
  if (!configuredUrl) return "";
  let url;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error("CHATTER_PUBLIC_URL must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("CHATTER_PUBLIC_URL must use HTTPS.");
  }
  return url.toString();
}

function getPaystackCallbackUrl(request, reference, returnToApp = false) {
  const configuredUrl = getPublicUrl();
  let baseUrl = configuredUrl;
  if (!baseUrl) {
    const host = request.headers.host || "";
    if (!/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/i.test(host)) {
      throw new HttpError(503, "Set CHATTER_PUBLIC_URL on the server before starting a Paystack checkout.");
    }
    baseUrl = `http://${host}`;
  }
  const callbackUrl = new URL(returnToApp ? "/app" : "/", baseUrl);
  callbackUrl.searchParams.set("payment", "number-subscription");
  callbackUrl.searchParams.set("reference", reference);
  return callbackUrl.toString();
}

function getPaystackLiveSecret() {
  const secret = process.env.PAYSTACK_SECRET_KEY || "";
  if (!secret) throw new HttpError(503, "Live checkout is not configured. Set PAYSTACK_SECRET_KEY in Render to your Paystack live secret.");
  if (!/^sk_live_[A-Za-z0-9]+$/.test(secret)) {
    throw new HttpError(503, "PAYSTACK_SECRET_KEY must be a live secret beginning with sk_live_. Test keys cannot be used to buy a number.");
  }
  return secret;
}

function getPaystackPlanCode() {
  const planCode = process.env.PAYSTACK_PLAN_CODE || "";
  if (!/^PLN_[A-Za-z0-9]+$/.test(planCode)) {
    throw new HttpError(503, "Set PAYSTACK_PLAN_CODE to your Paystack monthly NGN plan code before enabling subscriptions.");
  }
  return planCode;
}

async function callPaystack(path, options = {}) {
  let response;
  try {
    response = await fetch(`https://api.paystack.co${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${getPaystackLiveSecret()}`,
        "Content-Type": "application/json",
        ...options.headers
      },
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "Could not reach Paystack. Please try again.");
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new HttpError(502, "Paystack returned an unreadable response. Please try again.");
  }
  if (!payload || !response.ok || payload.status !== true) {
    throw new HttpError(502, typeof payload?.message === "string" ? `Paystack: ${payload.message}` : "Paystack could not complete the request.");
  }
  return payload.data;
}

function nextMonthlyPaymentDate(value) {
  const date = value ? new Date(value) : new Date();
  if (!value) date.setDate(date.getDate() + 30);
  return Number.isNaN(date.getTime()) ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : date.toISOString();
}

async function applyInitialNumberPayment(reference, payment) {
  const order = await database.prepare(`
    SELECT ns.id, ns.user_id, ns.number_id, ns.status, u.email, n.phone, n.status AS number_status,
      n.assigned_user_id, n.reserved_user_id
    FROM number_subscriptions ns
    JOIN users u ON u.id = ns.user_id
    JOIN foreign_numbers n ON n.id = ns.number_id
    WHERE ns.reference = ?
  `).get(reference);
  if (!order) throw new HttpError(404, "Number subscription checkout was not found.");
  if (order.status === "active") return order.user_id;
  if (!["pending", "pending_approval", "expired"].includes(order.status)) throw new HttpError(409, "This number checkout is no longer active.");
  if (order.status === "expired" && order.number_status !== "available") {
    throw new HttpError(409, "The selected number is no longer available. Contact support about your payment.");
  }
  if (
    payment.reference !== reference ||
    payment.status !== "success" ||
    payment.amount !== numberSubscriptionAmount ||
    payment.currency !== numberSubscriptionCurrency ||
    String(payment.customer?.email || "").toLowerCase() !== order.email.toLowerCase()
  ) {
    throw new HttpError(400, "Paystack has not verified the expected 10,000 NGN monthly payment for this account.");
  }
  if (order.number_status === "assigned" && order.assigned_user_id !== order.user_id) {
    throw new HttpError(409, "The selected number is no longer available. Contact support about your payment.");
  }
  if (order.number_status === "reserved" && order.reserved_user_id && order.reserved_user_id !== order.user_id) {
    throw new HttpError(409, "The selected number is no longer available. Contact support about your payment.");
  }
  const subscription = payment.subscription || {};
  const subscriptionCode = subscription.subscription_code || payment.subscription_code || null;
  const emailToken = subscription.email_token || payment.email_token || null;
  const nextPaymentAt = nextMonthlyPaymentDate(subscription.next_payment_date);
  if (order.number_status === "assigned") {
    throw new HttpError(409, "This paid request is not in a reservable state. Contact support.");
  }
  await database.transaction(async (transaction) => {
    await transaction.prepare(`
      UPDATE foreign_numbers
      SET status = 'reserved', assigned_user_id = NULL, reserved_user_id = ?, reserved_until = NULL
      WHERE id = ? AND status IN ('available', 'reserved')
        AND (reserved_user_id IS NULL OR reserved_user_id = ?)
    `).run(order.user_id, order.number_id, order.user_id);
    await transaction.prepare(`
      UPDATE number_subscriptions
      SET status = 'pending_approval',
        paystack_subscription_code = COALESCE(?, paystack_subscription_code),
        paystack_email_token = COALESCE(?, paystack_email_token),
        next_payment_at = ?, updated_at = now()
      WHERE id = ? AND status IN ('pending', 'pending_approval', 'expired')
        AND EXISTS (
          SELECT 1 FROM foreign_numbers
          WHERE id = ? AND status = 'reserved' AND reserved_user_id = ?
        )
    `).run(subscriptionCode, emailToken, nextPaymentAt, order.id, order.number_id, order.user_id);
    await transaction.prepare(`
      INSERT INTO number_subscription_payments (reference, subscription_id, amount, currency, status, paid_at)
      SELECT ?, ?, ?, ?, 'success', now()
      WHERE EXISTS (
        SELECT 1 FROM number_subscriptions ns
        JOIN foreign_numbers n ON n.id = ns.number_id
        WHERE ns.id = ? AND ns.status = 'pending_approval'
          AND n.status = 'reserved' AND n.reserved_user_id = ns.user_id
      )
      ON CONFLICT(reference) DO NOTHING
    `).run(reference, order.id, numberSubscriptionAmount, numberSubscriptionCurrency, order.id);
  });
  const saved = await database.prepare(`
    SELECT ns.status, n.status AS "numberStatus", n.reserved_user_id AS "reservedUserId",
      EXISTS (
        SELECT 1 FROM number_subscription_payments p
        WHERE p.subscription_id = ns.id AND p.reference = ns.reference AND p.status = 'success'
      ) AS "paymentRecorded"
    FROM number_subscriptions ns
    JOIN foreign_numbers n ON n.id = ns.number_id
    WHERE ns.id = ?
  `).get(order.id);
  if (saved?.status !== "pending_approval" || saved.numberStatus !== "reserved"
    || saved.reservedUserId !== order.user_id || !saved.paymentRecorded) {
    throw new HttpError(409, "Payment was received but the number could not be reserved. Contact support.");
  }
  await sendUserChatUpdates(order.user_id);
  return order.user_id;
}

async function applyRecurringNumberPayment(payment) {
  const subscriptionCode = payment.subscription?.subscription_code || payment.subscription_code;
  if (!subscriptionCode) throw new HttpError(400, "Paystack renewal event does not include its subscription code.");
  const subscription = await database.prepare(`
    SELECT ns.id, ns.user_id, ns.number_id, ns.status, ns.next_payment_at, u.email,
      n.assigned_user_id, n.reserved_user_id, n.status AS number_status
    FROM number_subscriptions ns
    JOIN users u ON u.id = ns.user_id
    JOIN foreign_numbers n ON n.id = ns.number_id
    WHERE ns.paystack_subscription_code = ?
  `).get(subscriptionCode);
  if (!subscription) return;
  if (
    payment.status !== "success" ||
    payment.amount !== numberSubscriptionAmount ||
    payment.currency !== numberSubscriptionCurrency ||
    String(payment.customer?.email || "").toLowerCase() !== subscription.email.toLowerCase()
  ) {
    throw new HttpError(400, "Paystack renewal does not match the account's 10,000 NGN subscription.");
  }
  const isPendingApproval = subscription.status === "pending_approval";
  const isRejected = subscription.status === "rejected";
  if (!isRejected && (isPendingApproval
    ? subscription.number_status !== "reserved" || subscription.reserved_user_id !== subscription.user_id
    : subscription.assigned_user_id !== subscription.user_id)) {
    throw new HttpError(409, "The subscribed number is no longer assigned to its customer.");
  }
  const recorded = await database.prepare(`
    INSERT INTO number_subscription_payments (reference, subscription_id, amount, currency, status, paid_at)
    VALUES (?, ?, ?, ?, 'success', now())
    ON CONFLICT(reference) DO NOTHING
  `).run(payment.reference, subscription.id, numberSubscriptionAmount, numberSubscriptionCurrency);
  if (!recorded.changes) return;
  if (isRejected) return;
  const nextPaymentAt = nextMonthlyPaymentDate(payment.subscription?.next_payment_date);
  await database.prepare(`
    UPDATE number_subscriptions
    SET status = CASE WHEN status = 'pending_approval' THEN 'pending_approval' ELSE 'active' END,
      next_payment_at = ?, updated_at = now()
    WHERE id = ?
  `).run(nextPaymentAt, subscription.id);
  await sendUserChatUpdates(subscription.user_id);
}

function welcomeEmail(name) {
  const safeName = escapeEmailHtml(name);
  const publicUrl = getPublicUrl();
  const button = publicUrl
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:26px 0 8px"><tr><td style="border-radius:9px;background:#1c9a70"><a href="${escapeEmailHtml(publicUrl)}" style="display:inline-block;padding:13px 22px;color:#fff;text-decoration:none;font-size:14px;font-weight:700">Open Chatter</a></td></tr></table>`
    : "";
  const html = `
    <!doctype html>
    <html lang="en">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="margin:0;padding:32px 12px;background:#f4f7f5;font-family:Arial,Helvetica,sans-serif;color:#203128">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;border-collapse:collapse">
          <tr><td style="padding:0 0 18px;text-align:center;font-size:23px;font-weight:700;letter-spacing:-1px;color:#203128">chatter<span style="color:#1c9a70">.</span></td></tr>
          <tr><td style="padding:34px 32px 30px;border-radius:18px;background:#fff;border:1px solid #e5ece7">
            <p style="margin:0 0 10px;color:#1c9a70;font-size:11px;font-weight:700;letter-spacing:1.5px">YOU’RE IN</p>
            <h1 style="margin:0 0 12px;font-size:25px;line-height:1.25;color:#203128">Welcome to Chatter, ${safeName}!</h1>
            <p style="margin:0;color:#6d7d73;font-size:15px;line-height:1.7">Your email is verified and your account is ready. Find your people, start a conversation, and stay close wherever you are.</p>
            ${button}
            <p style="margin:24px 0 0;color:#6d7d73;font-size:13px;line-height:1.7">We’re glad you’re here.<br><strong style="color:#203128">The Chatter team</strong></p>
          </td></tr>
          <tr><td style="padding:18px 12px 0;color:#94a198;text-align:center;font-size:11px;line-height:1.6">A little closer, wherever you are.<br>© Chatter</td></tr>
        </table>
      </body>
    </html>
  `;
  return {
    subject: "Welcome to Chatter!",
    html,
    text: `Welcome to Chatter, ${name}!\n\nYour email is verified and your account is ready. Find your people, start a conversation, and stay close wherever you are.\n\n${publicUrl ? `Open Chatter: ${publicUrl}\n\n` : ""}We’re glad you’re here.\nThe Chatter team`
  };
}

async function sendBrevoEmail({ email, name, subject, html, text }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) {
    throw new HttpError(503, "Email is not configured. Set BREVO_API_KEY and BREVO_SENDER_EMAIL on the server.");
  }
  const senderName = process.env.BREVO_SENDER_NAME || "Chatter";
  let response;
  try {
    response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "accept": "application/json", "api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: [{ name, email }],
        subject,
        htmlContent: html,
        textContent: text
      }),
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw new HttpError(502, "Could not reach Brevo to send email. Please try again shortly.");
  }
  if (!response.ok) {
    throw new HttpError(502, "Brevo could not send the email. Check that the API key and verified sender address are correct.");
  }
}

async function recordUserActivity(userId, action, details = {}, target = database) {
  await target.prepare("INSERT INTO user_activity (id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?)").run(
    randomBytes(16).toString("hex"),
    userId,
    action,
    JSON.stringify(details),
    new Date().toISOString()
  );
}

async function recordAdminAccess(action, reportId = null) {
  await database.prepare("INSERT INTO admin_access_log (id, action, report_id, created_at) VALUES (?, ?, ?, ?)").run(
    randomBytes(16).toString("hex"),
    action,
    reportId,
    new Date().toISOString()
  );
}

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function findSession(request, response) {
  const token = parseCookies(request.headers.cookie).chatter_session;
  const tokenHash = token && hashSessionToken(token);
  let session = token && sessions.get(token);
  if (token && !session) {
    const savedSession = await database.prepare("SELECT user_id, role, expires_at FROM sessions WHERE token_hash = ?").get(tokenHash);
    if (savedSession) {
      session = { userId: savedSession.user_id, role: savedSession.role, expiresAt: savedSession.expires_at };
      sessions.set(token, session);
    }
  }
  if (!session || session.expiresAt < Date.now()) {
    if (token) {
      sessions.delete(token);
      await database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    }
    if (response) response.setHeader("Set-Cookie", `chatter_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookieAttribute}`);
    return null;
  }
  session.expiresAt = Date.now() + sessionLifetime;
  await database.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(session.expiresAt, tokenHash);
  if (response) response.setHeader("Set-Cookie", `chatter_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetime / 1000}${secureCookieAttribute}`);
  return { token, userId: session.userId, role: session.role || "user" };
}

async function requireSession(request, response) {
  const session = await findSession(request, response);
  if (!session || session.role !== "user") throw new HttpError(401, "Please log in to continue.");
  return session;
}

async function requireModerator(request, response) {
  const session = await findSession(request, response);
  if (!session || session.role !== "moderator") throw new HttpError(401, "Moderator sign-in is required.");
  return session;
}

async function setSession(response, userId, role = "user") {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + sessionLifetime;
  sessions.set(token, { userId, role, expiresAt });
  await database.prepare("INSERT INTO sessions (token_hash, user_id, role, expires_at) VALUES (?, ?, ?, ?)").run(hashSessionToken(token), userId, role, expiresAt);
  response.setHeader("Set-Cookie", `chatter_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetime / 1000}${secureCookieAttribute}`);
}

async function clearSession(request, response) {
  const token = parseCookies(request.headers.cookie).chatter_session;
  if (token) {
    const userId = sessions.get(token)?.userId;
    const wasOnline = userId ? isUserOnline(userId) : false;
    sessions.delete(token);
    await database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashSessionToken(token));
    const streams = eventStreams.get(token);
    streams?.forEach((stream) => stream.end());
    eventStreams.delete(token);
    if (userId && wasOnline && !isUserOnline(userId)) {
      publishPresenceUpdates(userId).catch((error) => console.error("Could not update online status:", error));
    }
  }
  response.setHeader("Set-Cookie", `chatter_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookieAttribute}`);
}

function isUserOnline(userId) {
  for (const [token, session] of sessions) {
    if (session.userId === userId && session.expiresAt >= Date.now() && eventStreams.get(token)?.size) return true;
  }
  return false;
}

async function chatSummary(chatId, viewerId) {
  const chat = await database.prepare("SELECT * FROM chats WHERE id = ?").get(chatId);
  if (!chat) return null;
  const memberships = await database.prepare(`
    SELECT cm.user_id AS id, cm.display_name, u.name,
      COALESCE(assigned.phone, CASE WHEN u.phone LIKE '+234%' THEN u.phone END) AS phone, u.avatar_path
    FROM chat_members cm JOIN users u ON u.id = cm.user_id
    LEFT JOIN number_subscriptions ns
      ON ns.user_id = u.id AND ns.status = 'active'
      AND (ns.next_payment_at IS NULL OR ns.next_payment_at > now())
    LEFT JOIN foreign_numbers assigned
      ON assigned.id = ns.number_id AND assigned.assigned_user_id = u.id
    WHERE cm.chat_id = ?
  `).all(chatId);
  const self = memberships.find((member) => member.id === viewerId);
  if (!self) return null;
  const messageRows = (await database.prepare(`
    SELECT m.*, u.name AS sender_name, u.avatar_path AS sender_avatar_path FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.chat_id = ?
  `).all(chatId)).map((item) => ({
    id: item.id,
    from: item.sender_id === viewerId ? "you" : "them",
    ...(chat.type === "group" || chat.type === "community" ? { sender: item.sender_name } : {}),
    ...(chat.type === "group" || chat.type === "community" ? { senderAvatarUrl: avatarUrl(item.sender_id, item.sender_avatar_path) } : {}),
    text: item.text,
    createdAt: item.created_at,
    time: new Date(item.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    ...(item.attachment_name ? {
      attachment: {
        name: item.attachment_name,
        size: item.attachment_size,
        ...(item.attachment_mime ? { type: item.attachment_mime } : {}),
        ...(item.attachment_path ? { url: `/api/chats/${chatId}/media/${item.id}` } : {})
      }
    } : {})
  }));
  const callRows = (await database.prepare(`
    SELECT * FROM call_history WHERE chat_id = ?
  `).all(chatId)).map((item) => ({
    id: item.id,
    from: item.caller_id === viewerId ? "you" : "them",
    createdAt: item.created_at,
    time: new Date(item.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    call: {
      type: item.type,
      status: item.status,
      durationSeconds: item.duration_seconds,
      direction: item.caller_id === viewerId ? "outgoing" : "incoming"
    }
  }));
  const conversationItems = [...messageRows, ...callRows].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const latestItem = conversationItems.at(-1);
  const members = memberships.filter((member) => member.id !== viewerId);
  const isSelf = chat.type === "self";
  const other = isSelf ? self : members[0];
  const contact = chat.type === "direct"
    ? await database.prepare("SELECT display_name FROM contacts WHERE owner_id = ? AND contact_id = ?").get(viewerId, other.id)
    : null;
  const displayName = chat.type === "direct"
    ? contact?.display_name || other.name
    : isSelf ? `${self.name} (You)` : chat.name;
  const initials = displayName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  const latestItemPreview = latestItem?.call
    ? `${latestItem.from === "you" ? "You: " : ""}${latestItem.call.type === "audio" ? "Voice call" : "Video call"}`
    : latestItem
      ? `${latestItem.from === "you" ? "You: " : chat.type === "group" || chat.type === "community" ? `${latestItem.sender || "Member"}: ` : ""}${latestItem.attachment?.name || latestItem.text}`
      : "";
  const preview = latestItem
    ? latestItemPreview
    : chat.type === "group" || chat.type === "community" ? `${members.length + 1} members` : isSelf ? "Message yourself" : "Start a conversation";
  return {
    id: chat.id,
    name: displayName,
    initials,
    avatar: chat.type === "self" ? "avatar-you" : chat.type === "group" ? "avatar-team" : chat.type === "community" ? "avatar-design" : "avatar-marcus",
    avatarUrl: chat.type === "direct" ? avatarUrl(other.id, other.avatar_path) : "",
    online: chat.type === "direct" && isUserOnline(other.id),
    status: chat.type === "direct" ? contact ? other.phone : "Chatter contact" : chat.type === "self" ? "Message yourself" : `${members.length + 1} members`,
    ...(chat.type === "direct" ? { ...(contact ? { phone: other.phone } : {}), contactId: other.id } : {}),
    unread: 0,
    group: chat.type === "group" || chat.type === "community",
    community: chat.type === "community",
    self: isSelf,
    description: chat.description,
    memberIds: members.map((member) => member.id),
    time: latestItem?.time || "",
    preview,
    date: latestItem ? "Today" : "Today",
    messages: conversationItems.map(({ createdAt, ...item }) => item)
  };
}

async function getUserChats(userId) {
  const userChats = await database.prepare(`
    SELECT c.id FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
    LEFT JOIN (
      SELECT chat_id, MAX(created_at) AS latest_message_at
      FROM messages
      GROUP BY chat_id
    ) message_activity ON message_activity.chat_id = c.id
    LEFT JOIN (
      SELECT chat_id, MAX(created_at) AS latest_call_at
      FROM call_history
      GROUP BY chat_id
    ) call_activity ON call_activity.chat_id = c.id
    WHERE cm.user_id = ?
    ORDER BY CASE
      WHEN c.created_at >= COALESCE(message_activity.latest_message_at, c.created_at)
        AND c.created_at >= COALESCE(call_activity.latest_call_at, c.created_at)
        THEN c.created_at
      WHEN COALESCE(message_activity.latest_message_at, c.created_at) >= COALESCE(call_activity.latest_call_at, c.created_at)
        THEN message_activity.latest_message_at
      ELSE COALESCE(call_activity.latest_call_at, c.created_at)
    END DESC
  `).all(userId);
  return Promise.all(userChats.map(({ id }) => chatSummary(id, userId)));
}

function publish(userId, event) {
  for (const [token, session] of sessions) {
    if (session.userId !== userId) continue;
    for (const response of eventStreams.get(token) || []) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }
}

async function expireCalls() {
  const now = Date.now();
  for (const [callId, call] of calls) {
    if (call.expiresAt <= now) {
      calls.delete(callId);
      await database.prepare("UPDATE call_history SET status = 'missed', ended_at = ? WHERE id = ? AND status = 'ringing'").run(new Date(now).toISOString(), callId);
      const event = { type: "call", action: "ended", callId, reason: "no-answer" };
      await recordUserActivity(call.calleeId, "call.missed", { type: call.type });
      publish(call.callerId, event);
      publish(call.calleeId, event);
      await sendChatUpdate(call.chatId);
    }
  }
}

setInterval(() => {
  expireCalls().catch((error) => console.error("Could not expire calls:", error));
}, 30_000).unref();

async function ensureMember(chatId, userId) {
  if (!await database.prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?").get(chatId, userId)) {
    throw new HttpError(404, "Conversation not found.");
  }
}

async function sendChatUpdate(chatId) {
  const members = await database.prepare("SELECT user_id FROM chat_members WHERE chat_id = ?").all(chatId);
  for (const member of members) publish(member.user_id, { type: "chats", chats: await getUserChats(member.user_id) });
}

async function sendUserChatUpdates(userId) {
  const chats = await database.prepare("SELECT chat_id FROM chat_members WHERE user_id = ?").all(userId);
  for (const { chat_id: chatId } of chats) await sendChatUpdate(chatId);
}

async function sendMessagePushNotifications(chatId, senderId) {
  if (!vapidPublicKey) return;
  const [recipients, sender] = await Promise.all([
    database.prepare(`
      SELECT s.endpoint, s.p256dh, s.auth
      FROM push_subscriptions s
      JOIN chat_members cm ON cm.user_id = s.user_id
      WHERE cm.chat_id = ? AND cm.user_id != ?
    `).all(chatId, senderId),
    database.prepare("SELECT name FROM users WHERE id = ?").get(senderId)
  ]);
  if (!sender || !recipients.length) return;
  const payload = JSON.stringify({
    title: sender.name,
    body: "Sent you a message. Open Chatter to read it.",
    url: "/app"
  });
  await Promise.all(recipients.map(async (subscription) => {
    try {
      await webPush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth }
      }, payload, { TTL: 60, timeout: 5000 });
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        await database.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(subscription.endpoint);
      } else {
        console.error("Could not send a message push notification:", error.statusCode || error.message);
      }
    }
  }));
}

async function notifyStatusContacts(userId) {
  publish(userId, { type: "statuses" });
  const contacts = await database.prepare(`
    SELECT contact_id AS user_id FROM contacts WHERE owner_id = ?
    UNION
    SELECT owner_id AS user_id FROM contacts WHERE contact_id = ?
  `).all(userId, userId);
  for (const contact of contacts) publish(contact.user_id, { type: "statuses" });
}

async function cleanupExpiredStatuses() {
  const expired = await database.prepare("SELECT attachment_path FROM statuses WHERE expires_at <= now() AND attachment_path IS NOT NULL").all();
  await database.prepare("DELETE FROM statuses WHERE expires_at <= now()").run();
  for (const item of expired) await removeMediaObject(item.attachment_path);
}

setInterval(() => {
  cleanupExpiredStatuses().catch((error) => console.error("Could not expire statuses:", error));
}, 60 * 60 * 1000).unref();

async function publishPresenceUpdates(userId) {
  publish(userId, { type: "chats", chats: await getUserChats(userId) });
  const contacts = await database.prepare(`
    SELECT DISTINCT other.user_id AS id
    FROM chats c
    JOIN chat_members current ON current.chat_id = c.id
    JOIN chat_members other ON other.chat_id = c.id
    WHERE c.type = 'direct' AND current.user_id = ? AND other.user_id != ?
  `).all(userId, userId);
  for (const contact of contacts) {
    publish(contact.id, { type: "chats", chats: await getUserChats(contact.id) });
  }
}

async function handleApi(request, response, url) {
  const route = `${request.method} ${url.pathname}`;

  if (route === "POST /api/paystack/webhook") {
    const rawBody = await readRawBody(request);
    const signature = request.headers["x-paystack-signature"];
    if (typeof signature !== "string" || !/^[a-f0-9]{128}$/i.test(signature)) {
      throw new HttpError(401, "Invalid Paystack webhook signature.");
    }
    const expected = createHmac("sha512", getPaystackLiveSecret()).update(rawBody).digest();
    const supplied = Buffer.from(signature, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new HttpError(401, "Invalid Paystack webhook signature.");
    }
    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new HttpError(400, "Paystack webhook payload must be valid JSON.");
    }
    const payment = event.data || {};
    if (event.event === "charge.success") {
      if (typeof payment.reference === "string" && payment.reference.startsWith("chatter_number_")) {
        await applyInitialNumberPayment(payment.reference, payment);
      } else if (payment.subscription?.subscription_code || payment.subscription_code) {
        await applyRecurringNumberPayment(payment);
      }
    } else if (event.event === "subscription.create") {
      const email = String(payment.customer?.email || "").toLowerCase();
      const subscriptionCode = payment.subscription_code || payment.code;
      const emailToken = payment.email_token;
      if (email && typeof subscriptionCode === "string" && typeof emailToken === "string") {
        const row = await database.prepare(`
          SELECT ns.id, ns.user_id
          FROM number_subscriptions ns JOIN users u ON u.id = ns.user_id
          WHERE lower(u.email) = ? AND ns.status IN ('pending', 'pending_approval', 'active')
            AND ns.paystack_subscription_code IS NULL
          ORDER BY ns.created_at DESC LIMIT 1
        `).get(email);
        if (row) {
          await database.prepare(`
            UPDATE number_subscriptions
            SET paystack_subscription_code = ?, paystack_email_token = ?,
              next_payment_at = COALESCE(?, next_payment_at), updated_at = now()
            WHERE id = ?
          `).run(subscriptionCode, emailToken, payment.next_payment_date || null, row.id);
        }
      }
    } else if (event.event === "invoice.payment_failed") {
      const subscriptionCode = payment.subscription?.subscription_code || payment.subscription_code;
      if (subscriptionCode) {
        const row = await database.prepare("SELECT user_id FROM number_subscriptions WHERE paystack_subscription_code = ?").get(subscriptionCode);
        if (row) {
          await database.prepare(`
            UPDATE number_subscriptions
            SET status = CASE WHEN status = 'pending_approval' THEN 'pending_approval' ELSE 'past_due' END,
              updated_at = now()
            WHERE paystack_subscription_code = ?
              AND status IN ('pending_approval', 'active', 'past_due')
          `).run(subscriptionCode);
          await sendUserChatUpdates(row.user_id);
        }
      }
    } else if (event.event === "subscription.not_renew") {
      const subscriptionCode = payment.subscription_code || payment.code;
      if (subscriptionCode) {
        await database.prepare(`
          UPDATE number_subscriptions
          SET cancel_at_period_end = true, updated_at = now()
          WHERE paystack_subscription_code = ?
        `).run(subscriptionCode);
      }
    } else if (event.event === "subscription.disable") {
      const subscriptionCode = payment.subscription_code || payment.code;
      if (subscriptionCode) {
        const row = await database.prepare(`
          SELECT id, user_id, number_id, next_payment_at, status
          FROM number_subscriptions WHERE paystack_subscription_code = ?
        `).get(subscriptionCode);
        if (row) {
          if (row.status === "rejected") {
            return respond(response, 200, { ok: true });
          }
          if (row.status === "pending_approval") {
            await database.prepare(`
              UPDATE number_subscriptions SET cancel_at_period_end = true, updated_at = now()
              WHERE id = ? AND status = 'pending_approval'
            `).run(row.id);
          } else if (row.next_payment_at && new Date(row.next_payment_at).getTime() > Date.now()) {
            await database.prepare(`
              UPDATE number_subscriptions SET cancel_at_period_end = true, updated_at = now()
              WHERE id = ?
            `).run(row.id);
          } else {
            await database.prepare(`
              UPDATE number_subscriptions SET status = 'ended', updated_at = now() WHERE id = ?
            `).run(row.id);
            await database.prepare(`
              UPDATE foreign_numbers
              SET status = 'available', assigned_user_id = NULL, reserved_user_id = NULL, reserved_until = NULL
              WHERE id = ? AND (assigned_user_id = ? OR reserved_user_id = ?)
            `).run(row.number_id, row.user_id, row.user_id);
            await sendUserChatUpdates(row.user_id);
          }
        }
      }
    }
    return respond(response, 200, { received: true });
  }

  if (route === "GET /api/countries") return respond(response, 200, { countries: countryCallingCodes() });

  if (route === "POST /api/register/send-code") {
    if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) throw new HttpError(503, "Email is not configured. Set BREVO_API_KEY and BREVO_SENDER_EMAIL on the server.");
    const input = await readJson(request);
    const name = cleanText(input.name, "Name", 40);
    const email = cleanText(input.email, "Email", 254).toLowerCase();
    const phone = requireNigerianPhone(normalizePhone(input.phone));
    const password = typeof input.password === "string" ? input.password : "";
    if (name.length < 2) throw new HttpError(400, "Name must be at least 2 characters.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
    if (password.length < 8 || password.length > 128) throw new HttpError(400, "Password must be 8 to 128 characters.");
    if (await database.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new HttpError(409, "An account with that email already exists. Log in instead.");
    if (await database.prepare("SELECT 1 FROM users WHERE phone = ?").get(phone)) throw new HttpError(409, "An account with that phone number already exists.");
    const now = Date.now();
    await database.prepare("DELETE FROM pending_registrations WHERE email = ? AND expires_at <= ?").run(email, now);
    const pending = await database.prepare("SELECT last_sent_at, expires_at FROM pending_registrations WHERE email = ?").get(email);
    if (pending && now - pending.last_sent_at < verificationResendDelay) {
      const seconds = Math.ceil((verificationResendDelay - (now - pending.last_sent_at)) / 1000);
      throw new HttpError(429, `Please wait ${seconds} seconds before requesting another code.`);
    }
    const salt = randomBytes(16).toString("hex");
    const passwordHash = await scrypt(password, salt, 64);
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const codeHash = verificationCodeHash(email, code);
    const emailContent = verificationEmail(name, code);
    await database.prepare(`
      INSERT INTO pending_registrations (email, name, phone, password_hash, password_salt, verification_hash, attempts, expires_at, last_sent_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        name = excluded.name, phone = excluded.phone, password_hash = excluded.password_hash,
        password_salt = excluded.password_salt, verification_hash = excluded.verification_hash,
        attempts = 0, expires_at = excluded.expires_at, last_sent_at = excluded.last_sent_at
    `).run(email, name, phone, passwordHash.toString("hex"), salt, codeHash, now + verificationCodeLifetime, now);
    try {
      await sendBrevoEmail({ email, name, ...emailContent });
    } catch (error) {
      await database.prepare("DELETE FROM pending_registrations WHERE email = ? AND verification_hash = ?").run(email, codeHash);
      throw error;
    }
    return respond(response, 200, { sent: true, email });
  }

  if (route === "POST /api/register/verify-code") {
    if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) {
      throw new HttpError(503, "Email is not configured. Set BREVO_API_KEY and BREVO_SENDER_EMAIL on the server.");
    }
    const input = await readJson(request);
    const email = cleanText(input.email, "Email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
    const pending = await database.prepare("SELECT * FROM pending_registrations WHERE email = ?").get(email);
    if (!pending) throw new HttpError(400, "No active verification request was found. Return to registration and request a new code.");
    requireNigerianPhone(pending.phone);
    const now = Date.now();
    if (pending.expires_at <= now) {
      await database.prepare("DELETE FROM pending_registrations WHERE email = ?").run(email);
      throw new HttpError(400, "That code has expired. Return to registration and request a new one.");
    }
    const code = typeof input.code === "string" ? input.code.trim() : "";
    const isCodeFormatValid = /^\d{6}$/.test(code);
    const submittedHash = Buffer.from(verificationCodeHash(email, isCodeFormatValid ? code : "invalid"), "hex");
    const expectedHash = Buffer.from(pending.verification_hash, "hex");
    const isCodeCorrect = isCodeFormatValid && timingSafeEqual(submittedHash, expectedHash);
    if (!isCodeCorrect) {
      const attempts = pending.attempts + 1;
      if (attempts >= maxVerificationAttempts) {
        await database.prepare("DELETE FROM pending_registrations WHERE email = ?").run(email);
        throw new HttpError(429, "Too many incorrect codes. Return to registration and request a new one.");
      }
      await database.prepare("UPDATE pending_registrations SET attempts = ? WHERE email = ?").run(attempts, email);
      throw new HttpError(400, `That code is not correct. ${maxVerificationAttempts - attempts} attempts remaining.`);
    }

    const id = randomBytes(16).toString("hex");
    const shareToken = randomBytes(24).toString("hex");
    const createdAt = new Date(now).toISOString();
    await database.transaction(async (transaction) => {
      await transaction.prepare("INSERT INTO users (id, name, email, phone, share_token, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        id, pending.name, email, pending.phone, shareToken, pending.password_hash, pending.password_salt, createdAt
      );
      await recordUserActivity(id, "account.created", {}, transaction);
      await transaction.prepare("DELETE FROM pending_registrations WHERE email = ?").run(email);
    });
    await setSession(response, id);
    let welcomeEmailSent = true;
    try {
      const welcome = welcomeEmail(pending.name);
      await sendBrevoEmail({ email, name: pending.name, ...welcome });
    } catch (error) {
      welcomeEmailSent = false;
      console.error("Welcome email delivery failed:", error.message);
    }
    return respond(response, 201, {
      user: publicUser({ id, name: pending.name, email, phone: pending.phone, share_token: shareToken }),
      chats: [],
      welcomeEmailSent
    });
  }

  if (route === "POST /api/login") {
    const input = await readJson(request);
    const email = cleanText(input.email, "Email", 254).toLowerCase();
    const password = typeof input.password === "string" ? input.password : "";
    const user = await database.prepare("SELECT * FROM users WHERE email = ?").get(email);
    const supplied = await scrypt(password, user?.password_salt || "invalid-account-salt", 64);
    const expected = Buffer.from(user?.password_hash || "00".repeat(64), "hex");
    if (!user || !timingSafeEqual(supplied, expected)) throw new HttpError(401, "Email or password is incorrect.");
    await recordUserActivity(user.id, "session.signed_in");
    await setSession(response, user.id);
    return respond(response, 200, { user: publicUser(user), chats: await getUserChats(user.id) });
  }

  if (route === "POST /api/logout") {
    const current = await findSession(request);
    if (current?.role === "user") await recordUserActivity(current.userId, "session.signed_out");
    await clearSession(request, response);
    return respond(response, 200, { ok: true });
  }

  if (route === "POST /api/moderation/login") {
    if (moderatorPassword.length < 20) {
      throw new HttpError(503, "Moderator access is disabled. Configure CHATTER_MODERATOR_PASSWORD with at least 20 characters.");
    }
    const input = await readJson(request);
    const supplied = createHash("sha256").update(typeof input.password === "string" ? input.password : "").digest();
    if (!timingSafeEqual(supplied, moderatorPasswordHash)) throw new HttpError(401, "Moderator password is incorrect.");
    await setSession(response, null, "moderator");
    await recordAdminAccess("signed_in");
    return respond(response, 200, { authenticated: true });
  }

  if (route === "GET /api/moderation/session") {
    const current = await findSession(request, response);
    return respond(response, 200, { authenticated: current?.role === "moderator" });
  }

  if (route === "POST /api/moderation/logout") {
    const current = await requireModerator(request, response);
    await recordAdminAccess("signed_out");
    await clearSession(request, response);
    return respond(response, 200, { ok: true, wasModerator: current.role === "moderator" });
  }

  if (route === "GET /api/moderation/numbers") {
    await requireModerator(request, response);
    const numbers = await database.prepare(`
      SELECT n.id, n.phone, n.country, n.status, n.created_at AS "createdAt",
        u.name AS "assignedUserName", u.email AS "assignedUserEmail",
        ns.status AS "subscriptionStatus", ns.next_payment_at AS "nextPaymentAt"
      FROM foreign_numbers n
      LEFT JOIN users u ON u.id = COALESCE(n.reserved_user_id, n.assigned_user_id)
      LEFT JOIN number_subscriptions ns
        ON ns.number_id = n.id AND ns.user_id = COALESCE(n.reserved_user_id, n.assigned_user_id)
        AND ns.status IN ('pending_approval', 'active', 'past_due')
      ORDER BY n.created_at DESC
    `).all();
    return respond(response, 200, {
      numbers,
      countries: countryCallingCodes().filter((country) => country.country !== "NG")
    });
  }

  if (route === "POST /api/moderation/numbers") {
    await requireModerator(request, response);
    const input = await readJson(request);
    const phone = normalizePhone(input.phone);
    const countryCode = typeof input.countryCode === "string" ? input.countryCode.toUpperCase() : "";
    if (!getCountries().includes(countryCode) || countryCode === "NG") {
      throw new HttpError(400, "Choose a foreign country from the list.");
    }
    const country = new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode) || countryCode;
    if (phone.startsWith("+234")) throw new HttpError(400, "Only non-Nigerian numbers can be added as purchasable numbers.");
    const parsedPhone = parsePhoneNumber(phone);
    if (
      !phone.startsWith(`+${getCountryCallingCode(countryCode)}`) ||
      parsedPhone?.country !== countryCode ||
      !isValidPhoneNumber(phone, countryCode)
    ) {
      throw new HttpError(400, `Enter a valid ${country} number using the selected country's calling code and number length.`);
    }
    const id = randomBytes(16).toString("hex");
    try {
      await database.prepare(`
        INSERT INTO foreign_numbers (id, phone, country, status)
        VALUES (?, ?, ?, 'available')
      `).run(id, phone, country);
    } catch (error) {
      if (error.code === "23505") throw new HttpError(409, "That number is already in the inventory.");
      throw error;
    }
    await recordAdminAccess("number_added", id);
    return respond(response, 201, { number: { id, phone, country, status: "available" } });
  }

  const moderationNumberActionRoute = url.pathname.match(/^\/api\/moderation\/numbers\/([a-f0-9]{32})\/(approve|reject)$/);
  if (moderationNumberActionRoute && request.method === "POST") {
    await requireModerator(request, response);
    const [, numberId, action] = moderationNumberActionRoute;
    const input = await readJson(request);
    const requestRow = await database.prepare(`
      SELECT ns.id, ns.user_id, ns.status, ns.paystack_subscription_code AS "subscriptionCode",
        ns.paystack_email_token AS "emailToken", ns.next_payment_at AS "nextPaymentAt",
        n.reserved_user_id AS "reservedUserId",
        EXISTS (
          SELECT 1 FROM number_subscription_payments p
          WHERE p.subscription_id = ns.id AND p.status = 'success'
        ) AS "hasSuccessfulPayment"
      FROM number_subscriptions ns
      JOIN foreign_numbers n ON n.id = ns.number_id
      WHERE n.id = ? AND n.status = 'reserved'
        AND ns.number_id = n.id AND ns.user_id = n.reserved_user_id
      ORDER BY ns.created_at DESC LIMIT 1
    `).get(numberId);
    if (!requestRow || requestRow.status !== "pending_approval" || !requestRow.hasSuccessfulPayment) {
      throw new HttpError(409, "This number has no paid request awaiting approval.");
    }
    if (requestRow.reservedUserId !== requestRow.user_id) {
      throw new HttpError(409, "The number reservation no longer matches its customer.");
    }

    if (action === "approve") {
      if (!requestRow.subscriptionCode || !requestRow.emailToken) {
        throw new HttpError(409, "Paystack is still setting up recurring billing. Refresh and try again shortly.");
      }
      const paidThrough = new Date(requestRow.nextPaymentAt).getTime();
      if (!Number.isFinite(paidThrough) || paidThrough <= Date.now()) {
        throw new HttpError(409, "This request's paid period has ended. Resolve the request with the customer before approving it.");
      }
      await database.transaction(async (transaction) => {
        await transaction.prepare(`
          UPDATE foreign_numbers
          SET status = 'assigned', assigned_user_id = reserved_user_id,
            reserved_user_id = NULL, reserved_until = NULL
          WHERE id = ? AND status = 'reserved' AND reserved_user_id = ?
        `).run(numberId, requestRow.user_id);
        await transaction.prepare(`
          UPDATE number_subscriptions
          SET status = 'active', updated_at = now()
          WHERE id = ? AND status = 'pending_approval'
            AND EXISTS (
              SELECT 1 FROM foreign_numbers
              WHERE id = ? AND status = 'assigned' AND assigned_user_id = ?
            )
        `).run(requestRow.id, numberId, requestRow.user_id);
      });
      const approved = await database.prepare("SELECT status FROM number_subscriptions WHERE id = ?").get(requestRow.id);
      if (approved?.status !== "active") throw new HttpError(409, "The number request changed before it could be approved. Refresh and try again.");
      await recordAdminAccess("number_request_approved");
      await sendUserChatUpdates(requestRow.user_id);
      return respond(response, 200, { ok: true, status: "active" });
    }

    if (input.refundConfirmed !== true) {
      throw new HttpError(400, "Issue the customer's refund in Paystack first, then confirm it here.");
    }
    if (!requestRow.subscriptionCode || !requestRow.emailToken) {
      throw new HttpError(409, "Paystack is still setting up recurring billing. Refresh and try again shortly.");
    }
    await callPaystack("/subscription/disable", {
      method: "POST",
      body: JSON.stringify({
        code: requestRow.subscriptionCode,
        token: requestRow.emailToken
      })
    });
    await database.transaction(async (transaction) => {
      await transaction.prepare(`
        UPDATE number_subscriptions
        SET status = 'rejected', updated_at = now()
        WHERE id = ? AND status = 'pending_approval'
      `).run(requestRow.id);
      await transaction.prepare(`
        UPDATE foreign_numbers
        SET status = 'available', reserved_user_id = NULL, reserved_until = NULL
        WHERE id = ? AND status = 'reserved' AND reserved_user_id = ?
      `).run(numberId, requestRow.user_id);
    });
    const rejected = await database.prepare("SELECT status FROM number_subscriptions WHERE id = ?").get(requestRow.id);
    if (rejected?.status !== "rejected") throw new HttpError(409, "The number request changed before it could be rejected. Check its current status.");
    await recordAdminAccess("number_request_rejected");
    await sendUserChatUpdates(requestRow.user_id);
    return respond(response, 200, { ok: true, status: "rejected" });
  }

  const moderationNumberRoute = url.pathname.match(/^\/api\/moderation\/numbers\/([a-f0-9]{32})$/);
  if (moderationNumberRoute && request.method === "DELETE") {
    await requireModerator(request, response);
    const result = await database.prepare(`
      DELETE FROM foreign_numbers WHERE id = ? AND status = 'available'
    `).run(moderationNumberRoute[1]);
    if (!result.changes) throw new HttpError(409, "Only available, unassigned numbers can be removed.");
    await recordAdminAccess("number_removed", moderationNumberRoute[1]);
    return respond(response, 200, { removed: true });
  }

  if (route === "GET /api/moderation/overview") {
    await requireModerator(request, response);
    const users = Number((await database.prepare("SELECT COUNT(*) AS count FROM users").get()).count);
    const conversations = Number((await database.prepare("SELECT COUNT(*) AS count FROM chats").get()).count);
    const messages = Number((await database.prepare("SELECT COUNT(*) AS count FROM messages").get()).count);
    const reports = Number((await database.prepare("SELECT COUNT(*) AS count FROM message_reports WHERE status = 'open'").get()).count);
    const calls = await database.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'missed' OR status = 'cancelled' THEN 1 ELSE 0 END) AS missed,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM call_history
    `).get();
    const activity24Hours = Number((await database.prepare("SELECT COUNT(*) AS count FROM user_activity WHERE created_at >= ?").get(
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    )).count);
    const recentUsers = await database.prepare(`
      SELECT id, name, email, phone, created_at AS createdAt
      FROM users ORDER BY created_at DESC LIMIT 5
    `).all();
    return respond(response, 200, {
      totals: {
        users,
        conversations,
        messages,
        openReports: reports,
        calls: Number(calls.total),
        missedCalls: Number(calls.missed || 0),
        completedCalls: Number(calls.completed || 0),
        activity24Hours
      },
      recentUsers
    });
  }

  if (route === "GET /api/moderation/users") {
    await requireModerator(request, response);
    const search = (url.searchParams.get("search") || "").trim().slice(0, 120);
    const pattern = search ? `%${search.replace(/[\\%_]/g, "\\$&")}%` : null;
    const baseQuery = `
      SELECT u.id, u.name, u.email, u.phone, u.created_at AS "createdAt",
        last_activity."lastActiveAt" AS "lastActiveAt"
      FROM users u
      LEFT JOIN (
        SELECT user_id, MAX(created_at) AS "lastActiveAt"
        FROM user_activity
        GROUP BY user_id
      ) last_activity ON last_activity.user_id = u.id
    `;
    const users = pattern
      ? await database.prepare(`${baseQuery} WHERE LOWER(u.name) LIKE LOWER(?) OR LOWER(u.email) LIKE LOWER(?) OR LOWER(u.phone) LIKE LOWER(?) ORDER BY u.created_at DESC LIMIT 200`).all(pattern, pattern, pattern)
      : await database.prepare(`${baseQuery} ORDER BY u.created_at DESC LIMIT 200`).all();
    return respond(response, 200, { users });
  }

  if (route === "GET /api/moderation/activity") {
    await requireModerator(request, response);
    const userId = url.searchParams.get("userId") || null;
    const search = (url.searchParams.get("search") || "").trim().slice(0, 120);
    const pattern = search ? `%${search.replace(/[\\%_]/g, "\\$&")}%` : null;
    const offsetValue = Number(url.searchParams.get("offset") || 0);
    if (!Number.isSafeInteger(offsetValue) || offsetValue < 0) throw new HttpError(400, "Invalid activity page.");
    const limit = 100;
    const conditions = [];
    const values = [];
    if (userId) {
      conditions.push("a.user_id = ?");
      values.push(userId);
    }
    if (pattern) {
      conditions.push("(LOWER(u.name) LIKE LOWER(?) OR LOWER(u.email) LIKE LOWER(?) OR LOWER(u.phone) LIKE LOWER(?))");
      values.push(pattern, pattern, pattern);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = Number((await database.prepare(`
      SELECT COUNT(*) AS count
      FROM user_activity a LEFT JOIN users u ON u.id = a.user_id
      ${whereClause}
    `).get(...values)).count);
    const entries = (await database.prepare(`
      SELECT a.id, a.user_id AS userId, a.action, a.details, a.created_at AS createdAt,
        u.name AS userName, u.email AS userEmail
      FROM user_activity a LEFT JOIN users u ON u.id = a.user_id
      ${whereClause}
      ORDER BY a.created_at DESC LIMIT ? OFFSET ?
    `).all(...values, limit, offsetValue)).map((entry) => ({
      id: entry.id,
      userId: entry.userId,
      action: entry.action,
      details: typeof entry.details === "string" ? JSON.parse(entry.details) : entry.details,
      createdAt: entry.createdAt,
      userName: entry.userName || "Deleted account",
      userEmail: entry.userEmail || ""
    }));
    return respond(response, 200, { entries, total, limit, offset: offsetValue });
  }

  if (route === "GET /api/moderation/calls") {
    await requireModerator(request, response);
    const calls = await database.prepare(`
      SELECT c.id, c.type, c.status, c.created_at AS createdAt, c.accepted_at AS acceptedAt,
        c.ended_at AS endedAt, c.duration_seconds AS durationSeconds,
        caller.name AS callerName, caller.phone AS callerPhone,
        callee.name AS calleeName, callee.phone AS calleePhone
      FROM call_history c
      JOIN users caller ON caller.id = c.caller_id
      JOIN users callee ON callee.id = c.callee_id
      ORDER BY c.created_at DESC LIMIT 200
    `).all();
    return respond(response, 200, { calls });
  }

  if (route === "GET /api/moderation/system") {
    await requireModerator(request, response);
    const databaseStats = await database.prepare("SELECT MAX(created_at) AS updated_at FROM user_activity").get();
    const activeSessions = Number((await database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE expires_at >= ?").get(Date.now())).count);
    const openReports = Number((await database.prepare("SELECT COUNT(*) AS count FROM message_reports WHERE status = 'open'").get()).count);
    return respond(response, 200, {
      status: "running",
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      databaseBytes: null,
      databaseUpdatedAt: databaseStats.updated_at || new Date().toISOString(),
      activeSessions,
      openReports
    });
  }

  if (route === "GET /api/moderation/reports") {
    await requireModerator(request, response);
    const status = url.searchParams.get("status") || "open";
    if (!["open", "resolved", "dismissed", "all"].includes(status)) throw new HttpError(400, "Invalid report status filter.");
    const phoneDigits = (url.searchParams.get("phone") || "").replace(/\D/g, "");
    if (phoneDigits.length > 0 && phoneDigits.length < 3) throw new HttpError(400, "Enter at least 3 digits to search a phone number.");
    if (phoneDigits.length > 15) throw new HttpError(400, "Phone number search must be 15 digits or fewer.");
    const phonePattern = phoneDigits ? `%${phoneDigits}%` : null;
    const reports = await database.prepare(`
      SELECT r.id, r.chat_id, r.message_id, r.reason, r.status, r.created_at,
        m.text AS message_text, m.attachment_name, m.attachment_path,
        sender.name AS sender_name, sender.phone AS sender_phone,
        reporter.name AS reporter_name, reporter.phone AS reporter_phone,
        CASE WHEN c.type IN ('group', 'community') THEN c.name
          WHEN c.type = 'self' THEN 'Personal chat'
          ELSE 'Direct conversation' END AS conversation
      FROM message_reports r
      JOIN messages m ON m.id = r.message_id
      JOIN users sender ON sender.id = m.sender_id
      JOIN users reporter ON reporter.id = r.reporter_id
      JOIN chats c ON c.id = r.chat_id
      WHERE (? = 'all' OR r.status = ?)
        AND (? IS NULL OR sender.phone LIKE ? OR reporter.phone LIKE ?)
      ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC
      LIMIT 100
    `).all(status, status, phonePattern, phonePattern, phonePattern);
    const now = new Date().toISOString();
    const addAudit = database.prepare("INSERT INTO moderation_audit (id, report_id, actor_id, action, created_at) VALUES (?, ?, ?, 'viewed', ?)");
    for (const report of reports) {
      await addAudit.run(randomBytes(16).toString("hex"), report.id, "moderator", now);
      await recordAdminAccess("report_viewed", report.id);
    }
    return respond(response, 200, { reports: reports.map((report) => ({
      id: report.id,
      chatId: report.chat_id,
      messageId: report.message_id,
      reason: report.reason,
      status: report.status,
      createdAt: report.created_at,
      messageText: report.message_text,
      attachmentName: report.attachment_name,
      attachmentMediaUrl: report.attachment_path ? `/api/moderation/reports/${report.id}/image` : "",
      senderName: report.sender_name,
      senderPhone: report.sender_phone,
      reporterName: report.reporter_name,
      reporterPhone: report.reporter_phone,
      conversation: report.conversation
    })) });
  }

  const moderationImageRoute = url.pathname.match(/^\/api\/moderation\/reports\/([a-f0-9]+)\/image$/);
  if (moderationImageRoute && request.method === "GET") {
    await requireModerator(request, response);
    const reportId = moderationImageRoute[1];
    const report = await database.prepare(`
      SELECT m.attachment_path, m.attachment_mime
      FROM message_reports r JOIN messages m ON m.id = r.message_id
      WHERE r.id = ?
    `).get(reportId);
    if (!report?.attachment_path) throw new HttpError(404, "Reported image not found.");
    await database.prepare("INSERT INTO moderation_audit (id, report_id, actor_id, action, created_at) VALUES (?, ?, 'moderator', 'viewed_attachment', ?)").run(
      randomBytes(16).toString("hex"), reportId, new Date().toISOString()
    );
    await recordAdminAccess("report_attachment_viewed", reportId);
    return servePrivateImage(response, report.attachment_path, report.attachment_mime);
  }

  if (route === "GET /api/moderation/audit") {
    await requireModerator(request, response);
    const entries = await database.prepare(`
      SELECT combined.report_id AS reportId, combined.action, combined.actor_id AS actorId, combined.created_at AS createdAt
      FROM (
        SELECT a.report_id, a.action, a.actor_id, a.created_at FROM moderation_audit a
        UNION ALL
        SELECT l.report_id, l.action, 'moderator' AS actor_id, l.created_at FROM admin_access_log l
      ) combined
      ORDER BY combined.created_at DESC LIMIT 200
    `).all();
    return respond(response, 200, { entries });
  }

  const moderationReportRoute = url.pathname.match(/^\/api\/moderation\/reports\/([a-f0-9]+)$/);
  if (moderationReportRoute && request.method === "PATCH") {
    const moderator = await requireModerator(request, response);
    const [, reportId] = moderationReportRoute;
    const input = await readJson(request);
    if (!["resolved", "dismissed"].includes(input.status)) throw new HttpError(400, "Choose resolved or dismissed.");
    const result = await database.prepare(`
      UPDATE message_reports SET status = ? WHERE id = ? AND status = 'open'
    `).run(input.status, reportId);
    if (!result.changes) throw new HttpError(404, "Open report not found.");
    await database.prepare("INSERT INTO moderation_audit (id, report_id, actor_id, action, created_at) VALUES (?, ?, ?, ?, ?)").run(
      randomBytes(16).toString("hex"), reportId, moderator.role, input.status, new Date().toISOString()
    );
    await recordAdminAccess(`report_${input.status}`, reportId);
    return respond(response, 200, { ok: true });
  }

  if (route === "GET /api/session" || route === "GET /api/me") {
    const session = await findSession(request, response);
    if (!session || session.role !== "user") return respond(response, 200, { user: null, chats: [] });
    const user = await getPublicUser(session.userId);
    return respond(response, 200, { user: publicUser(user), chats: await getUserChats(session.userId) });
  }

  const session = await requireSession(request, response);
  if (route === "GET /api/push/config") {
    return respond(response, 200, { enabled: Boolean(vapidPublicKey), publicKey: vapidPublicKey });
  }

  if (route === "POST /api/push/subscriptions") {
    if (!vapidPublicKey) throw new HttpError(503, "Phone notifications are not configured on the server yet.");
    const input = await readJson(request);
    const endpoint = typeof input.endpoint === "string" ? input.endpoint : "";
    let endpointUrl;
    try {
      endpointUrl = new URL(endpoint);
    } catch {
      throw new HttpError(400, "The browser returned an invalid notification endpoint.");
    }
    const hostname = endpointUrl.hostname.toLowerCase();
    const approvedPushHost = hostname === "fcm.googleapis.com" ||
      hostname === "web.push.apple.com" || hostname.endsWith(".push.apple.com") ||
      hostname === "push.services.mozilla.com" || hostname.endsWith(".push.services.mozilla.com") ||
      hostname === "notify.windows.com" || hostname.endsWith(".notify.windows.com");
    if (endpointUrl.protocol !== "https:" || endpointUrl.username || endpointUrl.password ||
      endpointUrl.port && endpointUrl.port !== "443" || !approvedPushHost) {
      throw new HttpError(400, "The browser returned an invalid notification endpoint.");
    }
    const p256dh = input.keys?.p256dh;
    const auth = input.keys?.auth;
    if (endpoint.length > 2048 || typeof p256dh !== "string" || !/^[A-Za-z0-9_-]{80,120}$/.test(p256dh) ||
      typeof auth !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(auth)) {
      throw new HttpError(400, "The browser returned invalid notification keys.");
    }
    await database.prepare(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
        auth = excluded.auth, created_at = excluded.created_at
    `).run(randomBytes(16).toString("hex"), session.userId, endpoint, p256dh, auth, new Date().toISOString());
    return respond(response, 201, { ok: true });
  }

  if (route === "DELETE /api/push/subscriptions") {
    const input = await readJson(request);
    if (typeof input.endpoint !== "string" || input.endpoint.length > 2048) {
      throw new HttpError(400, "Choose a valid notification subscription.");
    }
    await database.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").run(session.userId, input.endpoint);
    return respond(response, 200, { ok: true });
  }

  if (route === "POST /api/profile/send-code") {
    if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) {
      throw new HttpError(503, "Email is not configured. Set BREVO_API_KEY and BREVO_SENDER_EMAIL on the server.");
    }
    const input = await readJson(request);
    const name = cleanText(input.name, "Name", 40);
    const email = cleanText(input.email, "Email", 254).toLowerCase();
    const phone = requireNigerianPhone(normalizePhone(input.phone));
    if (name.length < 2) throw new HttpError(400, "Name must be at least 2 characters.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
    const currentUser = await database.prepare("SELECT name, email, phone FROM users WHERE id = ?").get(session.userId);
    if (!currentUser) throw new HttpError(401, "Please log in to continue.");
    if (currentUser.name === name && currentUser.email.toLowerCase() === email && currentUser.phone === phone) {
      await database.prepare("DELETE FROM pending_profile_updates WHERE user_id = ?").run(session.userId);
      return respond(response, 200, { unchanged: true, user: publicUser(await getPublicUser(session.userId)) });
    }
    if (await database.prepare("SELECT 1 FROM users WHERE lower(email) = ? AND id != ?").get(email, session.userId)) {
      throw new HttpError(409, "That email is already in use.");
    }
    if (await database.prepare("SELECT 1 FROM users WHERE phone = ? AND id != ?").get(phone, session.userId)) {
      throw new HttpError(409, "That phone number is already in use.");
    }
    if (await database.prepare("SELECT 1 FROM pending_profile_updates WHERE email = ? AND user_id != ?").get(email, session.userId)) {
      throw new HttpError(409, "That email is being verified for another account.");
    }
    const now = Date.now();
    const pending = await database.prepare("SELECT last_sent_at FROM pending_profile_updates WHERE user_id = ?").get(session.userId);
    if (pending && now - pending.last_sent_at < verificationResendDelay) {
      const seconds = Math.ceil((verificationResendDelay - (now - pending.last_sent_at)) / 1000);
      throw new HttpError(429, `Please wait ${seconds} seconds before requesting another code.`);
    }
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const codeHash = profileVerificationCodeHash(session.userId, email, code);
    await database.prepare(`
      INSERT INTO pending_profile_updates (user_id, email, name, phone, verification_hash, attempts, expires_at, last_sent_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        email = excluded.email, name = excluded.name, phone = excluded.phone,
        verification_hash = excluded.verification_hash, attempts = 0,
        expires_at = excluded.expires_at, last_sent_at = excluded.last_sent_at
    `).run(session.userId, email, name, phone, codeHash, now + verificationCodeLifetime, now);
    try {
      await sendBrevoEmail({ email, name, ...profileVerificationEmail(name, code) });
    } catch (error) {
      await database.prepare("DELETE FROM pending_profile_updates WHERE user_id = ? AND verification_hash = ?")
        .run(session.userId, codeHash);
      throw error;
    }
    return respond(response, 200, { sent: true, email });
  }

  if (route === "POST /api/profile/verify-code") {
    if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) {
      throw new HttpError(503, "Email is not configured. Set BREVO_API_KEY and BREVO_SENDER_EMAIL on the server.");
    }
    const input = await readJson(request);
    const pending = await database.prepare("SELECT * FROM pending_profile_updates WHERE user_id = ?").get(session.userId);
    if (!pending) throw new HttpError(400, "No active account-change verification was found. Save your details to request a new code.");
    const now = Date.now();
    if (pending.expires_at <= now) {
      await database.prepare("DELETE FROM pending_profile_updates WHERE user_id = ?").run(session.userId);
      throw new HttpError(400, "That code has expired. Save your details to request a new one.");
    }
    const code = typeof input.code === "string" ? input.code.trim() : "";
    const isCodeFormatValid = /^\d{6}$/.test(code);
    const submittedHash = Buffer.from(
      profileVerificationCodeHash(session.userId, pending.email, isCodeFormatValid ? code : "invalid"),
      "hex"
    );
    const expectedHash = Buffer.from(pending.verification_hash, "hex");
    const isCodeCorrect = isCodeFormatValid && timingSafeEqual(submittedHash, expectedHash);
    if (!isCodeCorrect) {
      const attempts = pending.attempts + 1;
      if (attempts >= maxVerificationAttempts) {
        await database.prepare("DELETE FROM pending_profile_updates WHERE user_id = ?").run(session.userId);
        throw new HttpError(429, "Too many incorrect codes. Save your details to request a new one.");
      }
      await database.prepare("UPDATE pending_profile_updates SET attempts = ? WHERE user_id = ?").run(attempts, session.userId);
      throw new HttpError(400, `That code is not correct. ${maxVerificationAttempts - attempts} attempts remaining.`);
    }
    if (await database.prepare("SELECT 1 FROM users WHERE lower(email) = ? AND id != ?").get(pending.email, session.userId)) {
      await database.prepare("DELETE FROM pending_profile_updates WHERE user_id = ?").run(session.userId);
      throw new HttpError(409, "That email is no longer available. Update your details and request a new code.");
    }
    if (await database.prepare("SELECT 1 FROM users WHERE phone = ? AND id != ?").get(pending.phone, session.userId)) {
      await database.prepare("DELETE FROM pending_profile_updates WHERE user_id = ?").run(session.userId);
      throw new HttpError(409, "That phone number is no longer available. Update your details and request a new code.");
    }
    await database.transaction(async (transaction) => {
      await transaction.prepare("UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?")
        .run(pending.name, pending.email, pending.phone, session.userId);
      await recordUserActivity(session.userId, "profile.updated", {}, transaction);
      await transaction.prepare("DELETE FROM pending_profile_updates WHERE user_id = ?").run(session.userId);
    });
    await sendUserChatUpdates(session.userId);
    return respond(response, 200, { user: publicUser(await getPublicUser(session.userId)) });
  }

  if (route === "GET /api/numbers") {
    await database.prepare(`
      UPDATE foreign_numbers
      SET status = 'available', reserved_user_id = NULL, reserved_until = NULL
      WHERE status = 'reserved' AND reserved_until <= now()
    `).run();
    await database.prepare(`
      UPDATE number_subscriptions SET status = 'expired', updated_at = now()
      WHERE status = 'pending' AND created_at <= now() - interval '30 minutes'
    `).run();
    const expiredSubscriptions = await database.prepare(`
      SELECT id, user_id, number_id, cancel_at_period_end AS "cancelAtPeriodEnd"
      FROM number_subscriptions
      WHERE next_payment_at <= now()
        AND (
          status = 'active'
          OR (status IN ('past_due', 'pending_approval') AND cancel_at_period_end = true)
        )
    `).all();
    for (const expired of expiredSubscriptions) {
      const nextStatus = expired.cancelAtPeriodEnd ? "cancelled" : "past_due";
      await database.prepare(`
        UPDATE number_subscriptions SET status = ?, updated_at = now()
        WHERE id = ? AND status IN ('active', 'past_due', 'pending_approval')
      `).run(nextStatus, expired.id);
      if (expired.cancelAtPeriodEnd) {
        await database.prepare(`
          UPDATE foreign_numbers
          SET status = 'available', assigned_user_id = NULL, reserved_user_id = NULL, reserved_until = NULL
          WHERE id = ? AND (assigned_user_id = ? OR reserved_user_id = ?)
        `).run(expired.number_id, expired.user_id, expired.user_id);
      }
      await sendUserChatUpdates(expired.user_id);
    }
    const numbers = await database.prepare(`
      SELECT id, phone, country FROM foreign_numbers
      WHERE status = 'available' ORDER BY country, phone
    `).all();
    const subscription = await database.prepare(`
      SELECT ns.status, ns.cancel_at_period_end AS "cancelAtPeriodEnd",
        ns.next_payment_at AS "nextPaymentAt", n.phone, n.country
      FROM number_subscriptions ns
      JOIN foreign_numbers n ON n.id = ns.number_id
      WHERE ns.user_id = ? AND ns.status IN ('pending_approval', 'active', 'past_due')
      ORDER BY ns.created_at DESC LIMIT 1
    `).get(session.userId);
    const rejectedRequest = subscription ? null : await database.prepare(`
      SELECT n.phone, n.country
      FROM number_subscriptions ns
      JOIN foreign_numbers n ON n.id = ns.number_id
      WHERE ns.user_id = ? AND ns.status = 'rejected'
      ORDER BY ns.updated_at DESC LIMIT 1
    `).get(session.userId);
    const checkoutEnabled = /^sk_live_[A-Za-z0-9]+$/.test(process.env.PAYSTACK_SECRET_KEY || "")
      && /^PLN_[A-Za-z0-9]+$/.test(process.env.PAYSTACK_PLAN_CODE || "");
    return respond(response, 200, {
      numbers,
      subscription: subscription || null,
      rejectedRequest: rejectedRequest || null,
      price: numberSubscriptionAmount,
      currency: numberSubscriptionCurrency,
      checkoutEnabled
    });
  }

  if (route === "POST /api/numbers/subscribe") {
    const input = await readJson(request);
    getPaystackLiveSecret();
    const planCode = getPaystackPlanCode();
    const user = await database.prepare("SELECT email FROM users WHERE id = ?").get(session.userId);
    if (!user?.email) throw new HttpError(401, "Please log in to continue.");
    const existing = await database.prepare(`
      SELECT id FROM number_subscriptions
      WHERE user_id = ? AND status IN ('pending', 'pending_approval', 'active', 'past_due')
        AND (status != 'active' OR next_payment_at IS NULL OR next_payment_at > now())
      LIMIT 1
    `).get(session.userId);
    if (existing) throw new HttpError(409, "You already have an active number subscription or a checkout in progress.");
    const numberId = typeof input.numberId === "string" ? input.numberId : "";
    if (!/^[a-f0-9]{32}$/.test(numberId)) throw new HttpError(400, "Choose an available foreign number.");
    const number = await database.prepare(`
      SELECT id FROM foreign_numbers WHERE id = ? AND status = 'available'
    `).get(numberId);
    if (!number) throw new HttpError(409, "That number is no longer available. Refresh the list and choose another.");
    const subscriptionId = randomBytes(16).toString("hex");
    const reference = `chatter_number_${randomBytes(16).toString("hex")}`;
    const reserved = await database.prepare(`
      UPDATE foreign_numbers
      SET status = 'reserved', reserved_until = ?
      WHERE id = ? AND status = 'available'
    `).run(new Date(Date.now() + 30 * 60 * 1000).toISOString(), numberId);
    if (!reserved.changes) throw new HttpError(409, "That number was just reserved by another customer.");
    try {
      await database.prepare(`
        INSERT INTO number_subscriptions
          (id, user_id, number_id, reference, status, amount, currency)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `).run(subscriptionId, session.userId, numberId, reference, numberSubscriptionAmount, numberSubscriptionCurrency);
      const data = await callPaystack("/transaction/initialize", {
        method: "POST",
        body: JSON.stringify({
          email: user.email,
          plan: planCode,
          reference,
          callback_url: getPaystackCallbackUrl(request, reference, input.returnToApp === true),
          metadata: { purpose: "chatter_number_subscription", number_subscription_id: subscriptionId }
        })
      });
      if (!data || typeof data.authorization_url !== "string") {
        throw new HttpError(502, "Paystack returned an invalid checkout response.");
      }
      let authorizationUrl;
      try {
        authorizationUrl = new URL(data.authorization_url);
      } catch {
        throw new HttpError(502, "Paystack returned an invalid checkout response.");
      }
      if (data.reference !== reference || authorizationUrl.protocol !== "https:" || authorizationUrl.hostname !== "checkout.paystack.com") {
        throw new HttpError(502, "Paystack returned an invalid checkout response.");
      }
      return respond(response, 200, { authorizationUrl: authorizationUrl.toString() });
    } catch (error) {
      try {
        await database.prepare(`
          UPDATE number_subscriptions SET status = 'expired', updated_at = now()
          WHERE id = ? AND status = 'pending'
        `).run(subscriptionId);
        await database.prepare(`
          UPDATE foreign_numbers SET status = 'available', reserved_until = NULL
          WHERE id = ? AND status = 'reserved' AND reserved_user_id IS NULL
        `).run(numberId);
      } catch (releaseError) {
        console.error("Could not release a failed number checkout reservation:", releaseError.message);
      }
      throw error;
    }
  }

  if (route === "POST /api/numbers/verify") {
    const input = await readJson(request);
    const reference = typeof input.reference === "string" ? input.reference : "";
    if (!/^chatter_number_[a-f0-9]{32}$/.test(reference)) {
      throw new HttpError(400, "Invalid number subscription reference.");
    }
    const transaction = await database.prepare(`
      SELECT reference, status FROM number_subscriptions
      WHERE reference = ? AND user_id = ?
    `).get(reference, session.userId);
    if (!transaction) throw new HttpError(404, "Number subscription checkout was not found.");
    if (transaction.status === "active") return respond(response, 200, { verified: true, approved: true });
    if (transaction.status === "pending_approval") return respond(response, 200, { verified: true, approved: false });
    const payment = await callPaystack(`/transaction/verify/${encodeURIComponent(reference)}`);
    await applyInitialNumberPayment(reference, payment);
    return respond(response, 200, { verified: true, approved: false });
  }

  if (route === "POST /api/numbers/cancel") {
    const subscription = await database.prepare(`
      SELECT id, paystack_subscription_code, paystack_email_token
      FROM number_subscriptions
      WHERE user_id = ? AND status IN ('pending_approval', 'active', 'past_due')
        AND cancel_at_period_end = false
      ORDER BY created_at DESC LIMIT 1
    `).get(session.userId);
    if (!subscription) throw new HttpError(404, "No number subscription needs cancellation.");
    if (!subscription.paystack_subscription_code || !subscription.paystack_email_token) {
      throw new HttpError(409, "Paystack is still setting up recurring billing. Try again shortly.");
    }
    await callPaystack("/subscription/disable", {
      method: "POST",
      body: JSON.stringify({
        code: subscription.paystack_subscription_code,
        token: subscription.paystack_email_token
      })
    });
    await database.prepare(`
      UPDATE number_subscriptions
      SET cancel_at_period_end = true, updated_at = now()
      WHERE id = ?
    `).run(subscription.id);
    return respond(response, 200, { cancelled: true });
  }

  const avatarRoute = url.pathname.match(/^\/api\/avatars\/([a-f0-9]+)$/);
  if (avatarRoute && request.method === "GET") {
    const user = await database.prepare("SELECT avatar_path FROM users WHERE id = ?").get(avatarRoute[1]);
    if (!user?.avatar_path) throw new HttpError(404, "Profile photo not found.");
    return servePrivateImage(response, user.avatar_path, extname(user.avatar_path).toLowerCase() === ".png"
      ? "image/png"
      : extname(user.avatar_path).toLowerCase() === ".webp" ? "image/webp" : "image/jpeg");
  }

  const statusMediaRoute = url.pathname.match(/^\/api\/statuses\/([a-f0-9]+)\/media$/);
  if (statusMediaRoute && request.method === "GET") {
    const status = await database.prepare(`
      SELECT s.attachment_path, s.attachment_mime
      FROM statuses s
      WHERE s.id = ? AND s.expires_at > now()
        AND (s.user_id = ? OR EXISTS (
          SELECT 1 FROM contacts c
          WHERE (c.owner_id = ? AND c.contact_id = s.user_id)
             OR (c.owner_id = s.user_id AND c.contact_id = ?)
        ))
    `).get(statusMediaRoute[1], session.userId, session.userId, session.userId);
    if (!status?.attachment_path) throw new HttpError(404, "Status photo not found.");
    return servePrivateImage(response, status.attachment_path, status.attachment_mime);
  }

  if (route === "GET /api/statuses") {
    await cleanupExpiredStatuses();
    const statuses = await database.prepare(`
      SELECT s.id, s.user_id, s.text, s.attachment_path, s.created_at, s.expires_at,
        u.name, u.avatar_path, viewer_contact.display_name
      FROM statuses s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN contacts viewer_contact ON viewer_contact.owner_id = ? AND viewer_contact.contact_id = s.user_id
      WHERE s.expires_at > now()
        AND (s.user_id = ? OR EXISTS (
          SELECT 1 FROM contacts c
          WHERE (c.owner_id = ? AND c.contact_id = s.user_id)
             OR (c.owner_id = s.user_id AND c.contact_id = ?)
        ))
      ORDER BY s.created_at DESC
    `).all(session.userId, session.userId, session.userId, session.userId);
    return respond(response, 200, {
      statuses: statuses.map((status) => ({
        id: status.id,
        userId: status.user_id,
        name: status.user_id === session.userId ? "Your status" : status.display_name || status.name,
        text: status.text,
        createdAt: status.created_at,
        expiresAt: status.expires_at,
        avatarUrl: avatarUrl(status.user_id, status.avatar_path),
        ...(status.attachment_path ? { photoUrl: `/api/statuses/${status.id}/media` } : {})
      }))
    });
  }

  if (route === "POST /api/statuses") {
    const input = await readJson(request, Math.ceil(maxImageBytes / 3) * 4 + 16 * 1024);
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (text.length > 700) throw new HttpError(400, "Status text must be 700 characters or fewer.");
    const photo = input.photo ? imagePayload(input.photo) : null;
    if (!text && !photo) throw new HttpError(400, "Write a status or add a photo.");
    const id = randomBytes(16).toString("hex");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
    const photoPath = photo ? `statuses/${session.userId}/${id}.${photo.extension}` : null;
    if (photo) await uploadMediaObject(photoPath, photo.bytes, photo.mimeType);
    try {
      await database.prepare(`
        INSERT INTO statuses (id, user_id, text, attachment_path, attachment_mime, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, session.userId, text, photoPath, photo?.mimeType || null, createdAt.toISOString(), expiresAt.toISOString());
    } catch (error) {
      if (photoPath) await removeMediaObject(photoPath);
      throw error;
    }
    await recordUserActivity(session.userId, "status.created", { hasPhoto: Boolean(photo) });
    await notifyStatusContacts(session.userId);
    return respond(response, 201, { ok: true, id });
  }

  const statusRoute = url.pathname.match(/^\/api\/statuses\/([a-f0-9]+)$/);
  if (statusRoute && request.method === "DELETE") {
    const status = await database.prepare("SELECT attachment_path FROM statuses WHERE id = ? AND user_id = ?").get(statusRoute[1], session.userId);
    if (!status) throw new HttpError(404, "Status not found.");
    await database.prepare("DELETE FROM statuses WHERE id = ? AND user_id = ?").run(statusRoute[1], session.userId);
    if (status.attachment_path) await removeMediaObject(status.attachment_path);
    await notifyStatusContacts(session.userId);
    return respond(response, 200, { ok: true });
  }

  const chatMediaRoute = url.pathname.match(/^\/api\/chats\/([a-f0-9]+)\/media\/([a-f0-9]+)$/);
  if (chatMediaRoute && request.method === "GET") {
    const [, chatId, messageId] = chatMediaRoute;
    await ensureMember(chatId, session.userId);
    const message = await database.prepare("SELECT attachment_path, attachment_mime FROM messages WHERE id = ? AND chat_id = ?").get(messageId, chatId);
    if (!message?.attachment_path) throw new HttpError(404, "Image not found.");
    return servePrivateImage(response, message.attachment_path, message.attachment_mime);
  }

  if (route === "PATCH /api/profile/avatar") {
    const input = await readJson(request, Math.ceil(maxImageBytes / 3) * 4 + 16 * 1024);
    const image = imagePayload(input);
    const oldProfile = await database.prepare("SELECT avatar_path FROM users WHERE id = ?").get(session.userId);
    const objectPath = `profiles/${session.userId}/${randomBytes(12).toString("hex")}.${image.extension}`;
    await uploadMediaObject(objectPath, image.bytes, image.mimeType);
    try {
      await database.prepare("UPDATE users SET avatar_path = ? WHERE id = ?").run(objectPath, session.userId);
    } catch (error) {
      await removeMediaObject(objectPath);
      throw error;
    }
    if (oldProfile?.avatar_path) await removeMediaObject(oldProfile.avatar_path);
    await recordUserActivity(session.userId, "profile.photo.updated");
    await sendUserChatUpdates(session.userId);
    const user = await getPublicUser(session.userId);
    return respond(response, 200, { user: publicUser(user) });
  }

  if (route === "GET /api/rtc-config") return respond(response, 200, { iceServers });

  if (route === "POST /api/calls") {
    await expireCalls();
    const input = await readJson(request);
    if (typeof input.chatId !== "string" || !input.chatId) throw new HttpError(400, "Choose a direct conversation to call.");
    if (!["audio", "video"].includes(input.type)) throw new HttpError(400, "Choose an audio or video call.");
    const chat = await database.prepare("SELECT type FROM chats WHERE id = ?").get(input.chatId);
    if (!chat || chat.type !== "direct") throw new HttpError(400, "Calls are available only in direct conversations.");
    const members = await database.prepare(`
      SELECT user_id FROM chat_members WHERE chat_id = ? ORDER BY user_id
    `).all(input.chatId);
    if (members.length !== 2 || !members.some((member) => member.user_id === session.userId)) {
      throw new HttpError(404, "Direct conversation not found.");
    }
    const calleeId = members.find((member) => member.user_id !== session.userId).user_id;
    if (calleeId === session.userId) throw new HttpError(400, "You cannot call yourself. Open a conversation with another account.");
    if (!isUserOnline(calleeId)) throw new HttpError(409, "That person is offline. They need to have Chatter open to receive a call.");
    const busy = [...calls.values()].find((call) =>
      call.expiresAt > Date.now() && [call.callerId, call.calleeId].includes(session.userId)
    );
    if (busy) throw new HttpError(409, "You or that person is already on a call.");
    const callId = randomBytes(16).toString("hex");
    const call = {
      id: callId,
      chatId: input.chatId,
      callerId: session.userId,
      calleeId,
      type: input.type,
      status: "ringing",
      expiresAt: Date.now() + callRingLifetime
    };
    calls.set(callId, call);
    await database.prepare(`
      INSERT INTO call_history (id, chat_id, caller_id, callee_id, type, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'ringing', ?)
    `).run(callId, input.chatId, session.userId, calleeId, input.type, new Date().toISOString());
    await recordUserActivity(session.userId, "call.started", { type: input.type });
    const caller = await database.prepare("SELECT name FROM users WHERE id = ?").get(session.userId);
    publish(calleeId, {
      type: "call",
      action: "incoming",
      callId,
      chatId: input.chatId,
      callerName: caller.name,
      callType: call.type
    });
    await sendChatUpdate(call.chatId);
    return respond(response, 201, { callId });
  }

  const callRoute = url.pathname.match(/^\/api\/calls\/([a-f0-9]{32})\/(accept|decline|end|signal)$/);
  if (callRoute && request.method === "POST") {
    await expireCalls();
    const [, callId, action] = callRoute;
    const call = calls.get(callId);
    if (!call) throw new HttpError(404, "This call is no longer available.");
    if (![call.callerId, call.calleeId].includes(session.userId)) throw new HttpError(404, "Call not found.");
    const otherId = session.userId === call.callerId ? call.calleeId : call.callerId;
    if (action === "accept") {
      if (session.userId !== call.calleeId || call.status !== "ringing") throw new HttpError(409, "This call cannot be accepted.");
      call.status = "active";
      call.acceptedAt = Date.now();
      call.expiresAt = Date.now() + callLifetime;
      await database.prepare("UPDATE call_history SET status = 'active', accepted_at = ? WHERE id = ?").run(new Date(call.acceptedAt).toISOString(), callId);
      await recordUserActivity(session.userId, "call.answered", { type: call.type });
      publish(call.callerId, { type: "call", action: "accepted", callId });
      await sendChatUpdate(call.chatId);
      return respond(response, 200, { ok: true });
    }
    if (action === "decline") {
      if (session.userId !== call.calleeId || call.status !== "ringing") throw new HttpError(409, "This call cannot be declined.");
      calls.delete(callId);
      await database.prepare("UPDATE call_history SET status = 'declined', ended_at = ? WHERE id = ?").run(new Date().toISOString(), callId);
      await recordUserActivity(session.userId, "call.declined", { type: call.type });
      publish(call.callerId, { type: "call", action: "declined", callId });
      await sendChatUpdate(call.chatId);
      return respond(response, 200, { ok: true });
    }
    if (action === "end") {
      calls.delete(callId);
      const endedAt = Date.now();
      const status = call.status === "active" ? "completed" : session.userId === call.callerId ? "cancelled" : "missed";
      const durationSeconds = call.acceptedAt ? Math.max(0, Math.floor((endedAt - call.acceptedAt) / 1000)) : 0;
      await database.prepare("UPDATE call_history SET status = ?, ended_at = ?, duration_seconds = ? WHERE id = ?").run(
        status, new Date(endedAt).toISOString(), durationSeconds, callId
      );
      await recordUserActivity(session.userId, "call.ended", { type: call.type, status, durationSeconds });
      publish(otherId, { type: "call", action: "ended", callId, reason: status });
      await sendChatUpdate(call.chatId);
      return respond(response, 200, { ok: true });
    }
    if (call.status !== "active") throw new HttpError(409, "The call has not been accepted yet.");
    const input = await readJson(request);
    if (!["offer", "answer", "candidate"].includes(input.signalType) || !input.data || typeof input.data !== "object") {
      throw new HttpError(400, "Invalid call connection data.");
    }
    if (JSON.stringify(input.data).length > 100_000) throw new HttpError(413, "Call connection data is too large.");
    publish(otherId, { type: "call", action: "signal", callId, signalType: input.signalType, data: input.data });
    return respond(response, 200, { ok: true });
  }

  if (route === "GET /api/chats") return respond(response, 200, { chats: await getUserChats(session.userId) });

  if (route === "GET /api/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const streams = eventStreams.get(session.token) || new Set();
    streams.add(response);
    eventStreams.set(session.token, streams);
    response.write(`data: ${JSON.stringify({ type: "chats", chats: await getUserChats(session.userId) })}\n\n`);
    await publishPresenceUpdates(session.userId);
    const heartbeat = setInterval(() => {
      const activeSession = sessions.get(session.token);
      if (activeSession) {
        activeSession.expiresAt = Date.now() + sessionLifetime;
        database.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(activeSession.expiresAt, hashSessionToken(session.token)).catch((error) => {
          console.error("Could not extend session:", error);
          response.end();
        });
      }
      response.write(": heartbeat\n\n");
    }, 25000);
    response.on("close", () => {
      clearInterval(heartbeat);
      streams.delete(response);
      if (!streams.size) eventStreams.delete(session.token);
      if (!isUserOnline(session.userId)) {
        publishPresenceUpdates(session.userId).catch((error) => console.error("Could not update online status:", error));
      }
    });
    return;
  }

  if (route === "GET /api/contacts") {
    const contacts = await database.prepare(`
      SELECT u.id, c.display_name AS name,
        COALESCE(assigned.phone, CASE WHEN u.phone LIKE '+234%' THEN u.phone END) AS phone, u.email
      FROM contacts c JOIN users u ON u.id = c.contact_id
      LEFT JOIN number_subscriptions ns
        ON ns.user_id = u.id AND ns.status = 'active'
        AND (ns.next_payment_at IS NULL OR ns.next_payment_at > now())
      LEFT JOIN foreign_numbers assigned
        ON assigned.id = ns.number_id AND assigned.assigned_user_id = u.id
      WHERE c.owner_id = ? ORDER BY c.display_name COLLATE NOCASE
    `).all(session.userId);
    return respond(response, 200, { contacts });
  }

  if (route === "POST /api/contacts") {
    const input = await readJson(request);
    const name = cleanText(input.name, "Name", 40);
    if (name.length < 2) throw new HttpError(400, "Name must be at least 2 characters.");
    const phone = normalizePhone(input.phone);
    const contact = await database.prepare(`
      SELECT u.id, u.name, u.email,
        COALESCE(assigned.phone, CASE WHEN u.phone LIKE '+234%' THEN u.phone END) AS phone
      FROM users u
      LEFT JOIN number_subscriptions ns
        ON ns.user_id = u.id AND ns.status = 'active'
        AND (ns.next_payment_at IS NULL OR ns.next_payment_at > now())
      LEFT JOIN foreign_numbers assigned
        ON assigned.id = ns.number_id AND assigned.assigned_user_id = u.id
      WHERE (u.phone = ? AND u.phone LIKE '+234%') OR assigned.phone = ?
      LIMIT 1
    `).get(phone, phone);
    if (!contact) throw new HttpError(404, "No Chatter account uses that phone number yet.");
    if (contact.id === session.userId) throw new HttpError(400, "You cannot add your own number as a contact.");
    await database.prepare("INSERT INTO contacts (owner_id, contact_id, display_name) VALUES (?, ?, ?) ON CONFLICT(owner_id, contact_id) DO UPDATE SET display_name = excluded.display_name").run(session.userId, contact.id, name);
    await recordUserActivity(session.userId, "contact.added");
    let chat = await database.prepare(`
      SELECT c.id FROM chats c JOIN chat_members a ON a.chat_id = c.id JOIN chat_members b ON b.chat_id = c.id
      WHERE c.type = 'direct' AND a.user_id = ? AND b.user_id = ?
    `).get(session.userId, contact.id);
    if (!chat) {
      const id = randomBytes(16).toString("hex");
      await database.prepare("INSERT INTO chats (id, type, created_by, created_at) VALUES (?, 'direct', ?, ?)").run(id, session.userId, new Date().toISOString());
      const insertMember = database.prepare("INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)");
      await insertMember.run(id, session.userId);
      await insertMember.run(id, contact.id);
      chat = { id };
    }
    await sendChatUpdate(chat.id);
    return respond(response, 201, { chat: await chatSummary(chat.id, session.userId) });
  }

  const sharedChatRoute = url.pathname.match(/^\/api\/chats\/link\/([a-f0-9]{48})$/);
  if (sharedChatRoute && request.method === "POST") {
    const target = await database.prepare("SELECT id FROM users WHERE share_token = ?").get(sharedChatRoute[1]);
    if (!target) throw new HttpError(404, "This chat link is no longer available.");
    if (target.id === session.userId) throw new HttpError(400, "This is your own chat link.");
    let chat = await database.prepare(`
      SELECT c.id FROM chats c
      JOIN chat_members a ON a.chat_id = c.id
      JOIN chat_members b ON b.chat_id = c.id
      WHERE c.type = 'direct' AND a.user_id = ? AND b.user_id = ?
    `).get(session.userId, target.id);
    if (!chat) {
      const id = randomBytes(16).toString("hex");
      const createdAt = new Date().toISOString();
      await database.transaction(async (transaction) => {
        await transaction.prepare("INSERT INTO chats (id, type, created_by, created_at) VALUES (?, 'direct', ?, ?)").run(id, session.userId, createdAt);
        await transaction.prepare("INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)").run(id, session.userId);
        await transaction.prepare("INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)").run(id, target.id);
      });
      chat = { id };
      await recordUserActivity(session.userId, "conversation.created", { type: "direct", method: "share-link" });
    }
    await sendChatUpdate(chat.id);
    return respond(response, 200, { chat: await chatSummary(chat.id, session.userId) });
  }

  const messageReportRoute = url.pathname.match(/^\/api\/chats\/([a-f0-9]+)\/messages\/([a-f0-9]+)\/report$/);
  if (messageReportRoute && request.method === "POST") {
    const [, chatId, messageId] = messageReportRoute;
    await ensureMember(chatId, session.userId);
    const message = await database.prepare("SELECT sender_id FROM messages WHERE id = ? AND chat_id = ?").get(messageId, chatId);
    if (!message) throw new HttpError(404, "Message not found in this conversation.");
    if (message.sender_id === session.userId) throw new HttpError(400, "You can only report a message sent by someone else.");
    const input = await readJson(request);
    const reason = cleanText(input.reason, "Report reason", 300);
    if (reason.length < 4) throw new HttpError(400, "Please explain why you are reporting this message.");
    const id = randomBytes(16).toString("hex");
    await database.prepare(`
      INSERT INTO message_reports (id, chat_id, message_id, reporter_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, chatId, messageId, session.userId, reason, new Date().toISOString());
    await database.prepare("INSERT INTO moderation_audit (id, report_id, actor_id, action, created_at) VALUES (?, ?, ?, 'reported', ?)").run(
      randomBytes(16).toString("hex"), id, session.userId, new Date().toISOString()
    );
    const reportedChat = await database.prepare("SELECT type FROM chats WHERE id = ?").get(chatId);
    await recordUserActivity(session.userId, "message.reported", { conversationType: reportedChat.type });
    return respond(response, 201, { ok: true, reportId: id });
  }

  if (route === "POST /api/groups") {
    const input = await readJson(request);
    const name = cleanText(input.name, "Name", 50);
    const description = typeof input.description === "string" ? input.description.trim().slice(0, 180) : "";
    const type = input.type === "community" ? "community" : "group";
    const memberIds = Array.isArray(input.memberIds) ? [...new Set(input.memberIds.filter((id) => typeof id === "string" && id !== session.userId))] : [];
    if (name.length < 2) throw new HttpError(400, "Name must be at least 2 characters.");
    if (!memberIds.length) throw new HttpError(400, "Choose at least one contact.");
    const available = (await database.prepare(`SELECT contact_id AS id FROM contacts WHERE owner_id = ?`).all(session.userId)).map((row) => row.id);
    if (memberIds.some((id) => !available.includes(id))) throw new HttpError(403, "Groups can only include contacts you have saved.");
    const id = randomBytes(16).toString("hex");
    const createdAt = new Date().toISOString();
    await database.prepare("INSERT INTO chats (id, type, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, type, name, description, session.userId, createdAt);
    const insertMember = database.prepare("INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)");
    await insertMember.run(id, session.userId);
    for (const memberId of memberIds) await insertMember.run(id, memberId);
    await recordUserActivity(session.userId, "conversation.created", { type, memberCount: memberIds.length + 1 });
    await sendChatUpdate(id);
    return respond(response, 201, { chat: await chatSummary(id, session.userId) });
  }

  if (route === "POST /api/self-chat") {
    const existing = await database.prepare("SELECT id FROM chats WHERE type = 'self' AND created_by = ?").get(session.userId);
    if (existing) return respond(response, 200, { chat: await chatSummary(existing.id, session.userId) });
    const id = randomBytes(16).toString("hex");
    await database.prepare("INSERT INTO chats (id, type, created_by, created_at) VALUES (?, 'self', ?, ?)").run(id, session.userId, new Date().toISOString());
    await database.prepare("INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)").run(id, session.userId);
    await recordUserActivity(session.userId, "conversation.created", { type: "self" });
    await sendChatUpdate(id);
    return respond(response, 201, { chat: await chatSummary(id, session.userId) });
  }

  const chatRoute = url.pathname.match(/^\/api\/chats\/([a-f0-9]+)(?:\/(messages|contact))?$/);
  if (chatRoute) {
    const [, chatId, resource] = chatRoute;
    await ensureMember(chatId, session.userId);
    const chat = await database.prepare("SELECT * FROM chats WHERE id = ?").get(chatId);

    if (request.method === "GET" && resource === "messages") return respond(response, 200, { chat: await chatSummary(chatId, session.userId) });

    if (request.method === "POST" && resource === "messages") {
      const input = await readJson(request, Math.ceil(maxImageBytes / 3) * 4 + 16 * 1024);
      const text = typeof input.text === "string" ? input.text.trim() : "";
      const attachment = input.attachment
        ? { ...imagePayload(input.attachment), name: cleanText(input.attachment.name, "Image name", 180) }
        : null;
      if (!text && !attachment) throw new HttpError(400, "Write a message before sending.");
      if (text.length > 4000) throw new HttpError(400, "Messages must be 4,000 characters or fewer.");
      const createdAt = new Date().toISOString();
      const messageId = randomBytes(16).toString("hex");
      const attachmentPath = attachment ? `chats/${chatId}/${messageId}.${attachment.extension}` : null;
      if (attachment) await uploadMediaObject(attachmentPath, attachment.bytes, attachment.mimeType);
      try {
        await database.prepare("INSERT INTO messages (id, chat_id, sender_id, text, attachment_name, attachment_size, attachment_path, attachment_mime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          messageId,
          chatId,
          session.userId,
          text,
          attachment?.name || null,
          attachment ? imageSize(attachment.bytes) : null,
          attachmentPath,
          attachment?.mimeType || null,
          createdAt
        );
      } catch (error) {
        if (attachmentPath) await removeMediaObject(attachmentPath);
        throw error;
      }
      await recordUserActivity(session.userId, "message.sent", { conversationType: chat.type, hasAttachment: Boolean(attachment) });
      await sendChatUpdate(chatId);
      sendMessagePushNotifications(chatId, session.userId).catch((error) => {
        console.error("Could not send message push notifications:", error);
      });
      return respond(response, 201, { ok: true });
    }

    if (request.method === "PATCH" && resource === "contact" && chat.type === "direct") {
      const input = await readJson(request);
      const name = cleanText(input.name, "Name", 40);
      if (name.length < 2) throw new HttpError(400, "Name must be at least 2 characters.");
      const other = await database.prepare("SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?").get(chatId, session.userId);
      if (!other) throw new HttpError(404, "Contact not found.");
      await database.prepare("INSERT INTO contacts (owner_id, contact_id, display_name) VALUES (?, ?, ?) ON CONFLICT(owner_id, contact_id) DO UPDATE SET display_name = excluded.display_name").run(session.userId, other.user_id, name);
      await recordUserActivity(session.userId, "contact.renamed");
      await sendChatUpdate(chatId);
      return respond(response, 200, { chat: await chatSummary(chatId, session.userId) });
    }

    if (request.method === "DELETE" && resource === "messages") {
      const attachmentPaths = (await database.prepare("SELECT attachment_path FROM messages WHERE chat_id = ? AND attachment_path IS NOT NULL").all(chatId))
        .map((item) => item.attachment_path);
      await database.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
      for (const path of attachmentPaths) await removeMediaObject(path);
      await recordUserActivity(session.userId, "conversation.cleared", { conversationType: chat.type });
      await sendChatUpdate(chatId);
      return respond(response, 200, { chat: await chatSummary(chatId, session.userId) });
    }
  }

  if (route === "PATCH /api/profile") {
    throw new HttpError(400, "Save your details to request an email verification code.");
  }

  throw new HttpError(404, "API route not found.");
}

function serveStatic(request, response, url) {
  const pageRoutes = new Map([
    ["/app", "/app.html"],
    ["/app/", "/app.html"],
    ["/moderation", "/moderation.html"]
  ]);
  const pathname = pageRoutes.get(url.pathname) || url.pathname;
  let requestedPath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  requestedPath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const filePath = join(root, requestedPath);
  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const extension = extname(filePath);
  response.writeHead(200, {
    "Content-Type": mimeTypes[extension] || "application/octet-stream",
    "Cache-Control": [".html", ".js", ".css"].includes(extension) ? "no-cache" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin"
  });
  response.end(readFileSync(filePath));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
    serveStatic(request, response, url);
  } catch (error) {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof HttpError) {
      respond(response, error.status, { error: error.message });
      return;
    }
    if (error.code === "23505") {
      respond(response, 409, { error: "That account detail is already in use." });
      return;
    }
    console.error("Request failed:", error);
    respond(response, 500, { error: "The server could not complete that request." });
  }
});

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "127.0.0.1";
async function startServer() {
  await database.prepare("SELECT id FROM users LIMIT 0").all();
  await database.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  await database.prepare("DELETE FROM pending_registrations WHERE expires_at < ?").run(Date.now());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(`Chatter is running at http://localhost:${port}`);
}

startServer().catch((error) => {
  console.error("Could not start Chatter with Supabase. Check SUPABASE_PROJECT_ID, SUPABASE_SERVICE_ROLE_KEY, and run supabase-schema.sql in the Supabase SQL Editor.", error);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const streams of eventStreams.values()) for (const stream of streams) stream.end();
    server.close(() => process.exit(0));
  });
}
