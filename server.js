const { createHash, createHmac, randomBytes, randomInt, scrypt: scryptCallback, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const { createServer } = require("node:http");
const { existsSync, mkdirSync, readFileSync, statSync } = require("node:fs");
const { extname, join, normalize, resolve } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const scrypt = promisify(scryptCallback);
const root = __dirname;
const dataDirectory = resolve(process.env.CHATTER_DATA_DIR || join(root, "data"));
mkdirSync(dataDirectory, { recursive: true });
const databasePath = join(dataDirectory, "chatter.sqlite");
const database = new DatabaseSync(databasePath);
const secureCookieAttribute = process.env.NODE_ENV === "production" ? "; Secure" : "";
database.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pending_registrations (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    verification_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    last_sent_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('direct', 'group', 'community', 'self')),
    name TEXT,
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_members (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT,
    PRIMARY KEY (chat_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    attachment_name TEXT,
    attachment_size TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS call_history (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    caller_id TEXT NOT NULL REFERENCES users(id),
    callee_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK (type IN ('audio', 'video')),
    status TEXT NOT NULL CHECK (status IN ('ringing', 'active', 'completed', 'missed', 'declined', 'cancelled')),
    created_at TEXT NOT NULL,
    accepted_at TEXT,
    ended_at TEXT,
    duration_seconds INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS contacts (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    PRIMARY KEY (owner_id, contact_id),
    CHECK (owner_id != contact_id)
  );
  CREATE TABLE IF NOT EXISTS message_reports (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
    created_at TEXT NOT NULL,
    UNIQUE (message_id, reporter_id)
  );
  CREATE TABLE IF NOT EXISTS moderation_audit (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_activity (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_access_log (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    report_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT,
    role TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_chat_created ON messages(chat_id, created_at);
  CREATE INDEX IF NOT EXISTS call_history_chat_created ON call_history(chat_id, created_at);
  CREATE INDEX IF NOT EXISTS user_activity_created ON user_activity(created_at);
  CREATE INDEX IF NOT EXISTS user_activity_user_created ON user_activity(user_id, created_at);
  CREATE INDEX IF NOT EXISTS chat_members_user ON chat_members(user_id, chat_id);
  CREATE INDEX IF NOT EXISTS message_reports_status_created ON message_reports(status, created_at);
`);

database.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
database.prepare("DELETE FROM pending_registrations WHERE expires_at < ?").run(Date.now());
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
  ".json": "application/json; charset=utf-8"
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

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxRequestBytes) throw new HttpError(413, "Request is too large.");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
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

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, phone: user.phone };
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

function recordUserActivity(userId, action, details = {}) {
  database.prepare("INSERT INTO user_activity (id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?)").run(
    randomBytes(16).toString("hex"),
    userId,
    action,
    JSON.stringify(details),
    new Date().toISOString()
  );
}

function recordAdminAccess(action, reportId = null) {
  database.prepare("INSERT INTO admin_access_log (id, action, report_id, created_at) VALUES (?, ?, ?, ?)").run(
    randomBytes(16).toString("hex"),
    action,
    reportId,
    new Date().toISOString()
  );
}

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function findSession(request, response) {
  const token = parseCookies(request.headers.cookie).chatter_session;
  const tokenHash = token && hashSessionToken(token);
  let session = token && sessions.get(token);
  if (token && !session) {
    const savedSession = database.prepare("SELECT user_id, role, expires_at FROM sessions WHERE token_hash = ?").get(tokenHash);
    if (savedSession) {
      session = { userId: savedSession.user_id, role: savedSession.role, expiresAt: savedSession.expires_at };
      sessions.set(token, session);
    }
  }
  if (!session || session.expiresAt < Date.now()) {
    if (token) {
      sessions.delete(token);
      database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    }
    if (response) response.setHeader("Set-Cookie", `chatter_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookieAttribute}`);
    return null;
  }
  session.expiresAt = Date.now() + sessionLifetime;
  database.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(session.expiresAt, tokenHash);
  if (response) response.setHeader("Set-Cookie", `chatter_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetime / 1000}${secureCookieAttribute}`);
  return { token, userId: session.userId, role: session.role || "user" };
}

function requireSession(request, response) {
  const session = findSession(request, response);
  if (!session || session.role !== "user") throw new HttpError(401, "Please log in to continue.");
  return session;
}

function requireModerator(request, response) {
  const session = findSession(request, response);
  if (!session || session.role !== "moderator") throw new HttpError(401, "Moderator sign-in is required.");
  return session;
}

function setSession(response, userId, role = "user") {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + sessionLifetime;
  sessions.set(token, { userId, role, expiresAt });
  database.prepare("INSERT INTO sessions (token_hash, user_id, role, expires_at) VALUES (?, ?, ?, ?)").run(hashSessionToken(token), userId, role, expiresAt);
  response.setHeader("Set-Cookie", `chatter_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetime / 1000}${secureCookieAttribute}`);
}

function clearSession(request, response) {
  const token = parseCookies(request.headers.cookie).chatter_session;
  if (token) {
    const userId = sessions.get(token)?.userId;
    const wasOnline = userId ? isUserOnline(userId) : false;
    sessions.delete(token);
    database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashSessionToken(token));
    const streams = eventStreams.get(token);
    streams?.forEach((stream) => stream.end());
    eventStreams.delete(token);
    if (userId && wasOnline && !isUserOnline(userId)) publishPresenceUpdates(userId);
  }
  response.setHeader("Set-Cookie", `chatter_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookieAttribute}`);
}

function isUserOnline(userId) {
  for (const [token, session] of sessions) {
    if (session.userId === userId && session.expiresAt >= Date.now() && eventStreams.get(token)?.size) return true;
  }
  return false;
}

function chatSummary(chatId, viewerId) {
  const chat = database.prepare("SELECT * FROM chats WHERE id = ?").get(chatId);
  if (!chat) return null;
  const memberships = database.prepare(`
    SELECT cm.user_id AS id, cm.display_name, u.name, u.phone
    FROM chat_members cm JOIN users u ON u.id = cm.user_id
    WHERE cm.chat_id = ?
  `).all(chatId);
  const self = memberships.find((member) => member.id === viewerId);
  if (!self) return null;
  const messageRows = database.prepare(`
    SELECT m.*, u.name AS sender_name FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.chat_id = ?
  `).all(chatId).map((item) => ({
    id: item.id,
    from: item.sender_id === viewerId ? "you" : "them",
    ...(chat.type === "group" || chat.type === "community" ? { sender: item.sender_name } : {}),
    text: item.text,
    createdAt: item.created_at,
    time: new Date(item.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    ...(item.attachment_name ? { attachment: { name: item.attachment_name, size: item.attachment_size } } : {})
  }));
  const callRows = database.prepare(`
    SELECT * FROM call_history WHERE chat_id = ?
  `).all(chatId).map((item) => ({
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
  const displayName = chat.type === "direct"
    ? database.prepare("SELECT display_name FROM contacts WHERE owner_id = ? AND contact_id = ?").get(viewerId, other.id)?.display_name || other.name
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
    online: chat.type === "direct" && isUserOnline(other.id),
    status: chat.type === "direct" ? other.phone : chat.type === "self" ? "Message yourself" : `${members.length + 1} members`,
    ...(chat.type === "direct" ? { phone: other.phone, contactId: other.id } : {}),
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

function getUserChats(userId) {
  return database.prepare(`
    SELECT c.id FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
    WHERE cm.user_id = ?
    ORDER BY MAX(
      c.created_at,
      COALESCE((SELECT MAX(created_at) FROM messages WHERE chat_id = c.id), c.created_at),
      COALESCE((SELECT MAX(created_at) FROM call_history WHERE chat_id = c.id), c.created_at)
    ) DESC
  `).all(userId).map(({ id }) => chatSummary(id, userId));
}

function publish(userId, event) {
  for (const [token, session] of sessions) {
    if (session.userId !== userId) continue;
    for (const response of eventStreams.get(token) || []) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }
}

function expireCalls() {
  const now = Date.now();
  for (const [callId, call] of calls) {
    if (call.expiresAt <= now) {
      calls.delete(callId);
      database.prepare("UPDATE call_history SET status = 'missed', ended_at = ? WHERE id = ? AND status = 'ringing'").run(new Date(now).toISOString(), callId);
      const event = { type: "call", action: "ended", callId, reason: "no-answer" };
      recordUserActivity(call.calleeId, "call.missed", { type: call.type });
      publish(call.callerId, event);
      publish(call.calleeId, event);
      sendChatUpdate(call.chatId);
    }
  }
}

setInterval(expireCalls, 30_000).unref();

function ensureMember(chatId, userId) {
  if (!database.prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?").get(chatId, userId)) {
    throw new HttpError(404, "Conversation not found.");
  }
}

function sendChatUpdate(chatId) {
  const members = database.prepare("SELECT user_id FROM chat_members WHERE chat_id = ?").all(chatId);
  for (const member of members) publish(member.user_id, { type: "chats", chats: getUserChats(member.user_id) });
}

function publishPresenceUpdates(userId) {
  publish(userId, { type: "chats", chats: getUserChats(userId) });
  const contacts = database.prepare(`
    SELECT DISTINCT other.user_id AS id
    FROM chats c
    JOIN chat_members current ON current.chat_id = c.id
    JOIN chat_members other ON other.chat_id = c.id
    WHERE c.type = 'direct' AND current.user_id = ? AND other.user_id != ?
  `).all(userId, userId);
  for (const contact of contacts) {
    publish(contact.id, { type: "chats", chats: getUserChats(contact.id) });
  }
}

async function handleApi(request, response, url) {
  const route = `${request.method} ${url.pathname}`;

  if (route === "POST /api/register/send-code") {
    if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) throw new HttpError(503, "Email is not configured. Set BREVO_API_KEY and BREVO_SENDER_EMAIL on the server.");
    const input = await readJson(request);
    const name = cleanText(input.name, "Name", 40);
    const email = cleanText(input.email, "Email", 254).toLowerCase();
    const phone = normalizePhone(input.phone);
    const password = typeof input.password === "string" ? input.password : "";
    if (name.length < 2) throw new HttpError(400, "Name must be at least 2 characters.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
    if (password.length < 8 || password.length > 128) throw new HttpError(400, "Password must be 8 to 128 characters.");
    if (database.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").get(email)) throw new HttpError(409, "An account with that email already exists. Log in instead.");
    if (database.prepare("SELECT 1 FROM users WHERE phone = ?").get(phone)) throw new HttpError(409, "An account with that phone number already exists.");
    const now = Date.now();
    database.prepare("DELETE FROM pending_registrations WHERE email = ? COLLATE NOCASE AND expires_at <= ?").run(email, now);
    const pending = database.prepare("SELECT last_sent_at, expires_at FROM pending_registrations WHERE email = ? COLLATE NOCASE").get(email);
    if (pending && now - pending.last_sent_at < verificationResendDelay) {
      const seconds = Math.ceil((verificationResendDelay - (now - pending.last_sent_at)) / 1000);
      throw new HttpError(429, `Please wait ${seconds} seconds before requesting another code.`);
    }
    const salt = randomBytes(16).toString("hex");
    const passwordHash = await scrypt(password, salt, 64);
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const codeHash = verificationCodeHash(email, code);
    const emailContent = verificationEmail(name, code);
    database.prepare(`
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
      database.prepare("DELETE FROM pending_registrations WHERE email = ? COLLATE NOCASE AND verification_hash = ?").run(email, codeHash);
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
    const pending = database.prepare("SELECT * FROM pending_registrations WHERE email = ? COLLATE NOCASE").get(email);
    if (!pending) throw new HttpError(400, "No active verification request was found. Return to registration and request a new code.");
    const now = Date.now();
    if (pending.expires_at <= now) {
      database.prepare("DELETE FROM pending_registrations WHERE email = ? COLLATE NOCASE").run(email);
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
        database.prepare("DELETE FROM pending_registrations WHERE email = ? COLLATE NOCASE").run(email);
        throw new HttpError(429, "Too many incorrect codes. Return to registration and request a new one.");
      }
      database.prepare("UPDATE pending_registrations SET attempts = ? WHERE email = ? COLLATE NOCASE").run(attempts, email);
      throw new HttpError(400, `That code is not correct. ${maxVerificationAttempts - attempts} attempts remaining.`);
    }

    const id = randomBytes(16).toString("hex");
    const createdAt = new Date(now).toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("INSERT INTO users (id, name, email, phone, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        id, pending.name, email, pending.phone, pending.password_hash, pending.password_salt, createdAt
      );
      recordUserActivity(id, "account.created");
      database.prepare("DELETE FROM pending_registrations WHERE email = ? COLLATE NOCASE").run(email);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    setSession(response, id);
    let welcomeEmailSent = true;
    try {
      const welcome = welcomeEmail(pending.name);
      await sendBrevoEmail({ email, name: pending.name, ...welcome });
    } catch (error) {
      welcomeEmailSent = false;
      console.error("Welcome email delivery failed:", error.message);
    }
    return respond(response, 201, {
      user: publicUser({ id, name: pending.name, email, phone: pending.phone }),
      chats: [],
      welcomeEmailSent
    });
  }

  if (route === "POST /api/login") {
    const input = await readJson(request);
    const email = cleanText(input.email, "Email", 254).toLowerCase();
    const password = typeof input.password === "string" ? input.password : "";
    const user = database.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email);
    const supplied = await scrypt(password, user?.password_salt || "invalid-account-salt", 64);
    const expected = Buffer.from(user?.password_hash || "00".repeat(64), "hex");
    if (!user || !timingSafeEqual(supplied, expected)) throw new HttpError(401, "Email or password is incorrect.");
    recordUserActivity(user.id, "session.signed_in");
    setSession(response, user.id);
    return respond(response, 200, { user: publicUser(user), chats: getUserChats(user.id) });
  }

  if (route === "POST /api/logout") {
    const current = findSession(request);
    if (current?.role === "user") recordUserActivity(current.userId, "session.signed_out");
    clearSession(request, response);
    return respond(response, 200, { ok: true });
  }

  if (route === "POST /api/moderation/login") {
    if (moderatorPassword.length < 20) {
      throw new HttpError(503, "Moderator access is disabled. Configure CHATTER_MODERATOR_PASSWORD with at least 20 characters.");
    }
    const input = await readJson(request);
    const supplied = createHash("sha256").update(typeof input.password === "string" ? input.password : "").digest();
    if (!timingSafeEqual(supplied, moderatorPasswordHash)) throw new HttpError(401, "Moderator password is incorrect.");
    setSession(response, null, "moderator");
    recordAdminAccess("signed_in");
    return respond(response, 200, { authenticated: true });
  }

  if (route === "GET /api/moderation/session") {
    const current = findSession(request, response);
    return respond(response, 200, { authenticated: current?.role === "moderator" });
  }

  if (route === "POST /api/moderation/logout") {
    const current = requireModerator(request, response);
    recordAdminAccess("signed_out");
    clearSession(request, response);
    return respond(response, 200, { ok: true, wasModerator: current.role === "moderator" });
  }

  if (route === "GET /api/moderation/overview") {
    requireModerator(request, response);
    const users = database.prepare("SELECT COUNT(*) AS count FROM users").get().count;
    const conversations = database.prepare("SELECT COUNT(*) AS count FROM chats").get().count;
    const messages = database.prepare("SELECT COUNT(*) AS count FROM messages").get().count;
    const reports = database.prepare("SELECT COUNT(*) AS count FROM message_reports WHERE status = 'open'").get().count;
    const calls = database.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'missed' OR status = 'cancelled' THEN 1 ELSE 0 END) AS missed,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM call_history
    `).get();
    const activity24Hours = database.prepare("SELECT COUNT(*) AS count FROM user_activity WHERE created_at >= ?").get(
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    ).count;
    const recentUsers = database.prepare(`
      SELECT id, name, email, phone, created_at AS createdAt
      FROM users ORDER BY created_at DESC LIMIT 5
    `).all();
    return respond(response, 200, {
      totals: {
        users,
        conversations,
        messages,
        openReports: reports,
        calls: calls.total,
        missedCalls: calls.missed || 0,
        completedCalls: calls.completed || 0,
        activity24Hours
      },
      recentUsers
    });
  }

  if (route === "GET /api/moderation/users") {
    requireModerator(request, response);
    const search = (url.searchParams.get("search") || "").trim().slice(0, 120);
    const pattern = search ? `%${search.replace(/[\\%_]/g, "\\$&")}%` : null;
    const users = database.prepare(`
      SELECT u.id, u.name, u.email, u.phone, u.created_at AS createdAt,
        (SELECT MAX(a.created_at) FROM user_activity a WHERE a.user_id = u.id) AS lastActiveAt
      FROM users u
      WHERE (? IS NULL OR u.name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR u.email LIKE ? ESCAPE '\\' COLLATE NOCASE OR u.phone LIKE ? ESCAPE '\\')
      ORDER BY u.created_at DESC LIMIT 200
    `).all(pattern, pattern, pattern, pattern);
    return respond(response, 200, { users });
  }

  if (route === "GET /api/moderation/activity") {
    requireModerator(request, response);
    const userId = url.searchParams.get("userId") || null;
    const search = (url.searchParams.get("search") || "").trim().slice(0, 120);
    const pattern = search ? `%${search.replace(/[\\%_]/g, "\\$&")}%` : null;
    const offsetValue = Number(url.searchParams.get("offset") || 0);
    if (!Number.isSafeInteger(offsetValue) || offsetValue < 0) throw new HttpError(400, "Invalid activity page.");
    const limit = 100;
    const filters = `
      (? IS NULL OR a.user_id = ?)
      AND (? IS NULL OR u.name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR u.email LIKE ? ESCAPE '\\' COLLATE NOCASE OR u.phone LIKE ? ESCAPE '\\')
    `;
    const total = database.prepare(`
      SELECT COUNT(*) AS count
      FROM user_activity a LEFT JOIN users u ON u.id = a.user_id
      WHERE ${filters}
    `).get(userId, userId, pattern, pattern, pattern, pattern).count;
    const entries = database.prepare(`
      SELECT a.id, a.user_id AS userId, a.action, a.details, a.created_at AS createdAt,
        u.name AS userName, u.email AS userEmail
      FROM user_activity a LEFT JOIN users u ON u.id = a.user_id
      WHERE ${filters}
      ORDER BY a.created_at DESC LIMIT ? OFFSET ?
    `).all(userId, userId, pattern, pattern, pattern, pattern, limit, offsetValue).map((entry) => ({
      id: entry.id,
      userId: entry.userId,
      action: entry.action,
      details: JSON.parse(entry.details),
      createdAt: entry.createdAt,
      userName: entry.userName || "Deleted account",
      userEmail: entry.userEmail || ""
    }));
    return respond(response, 200, { entries, total, limit, offset: offsetValue });
  }

  if (route === "GET /api/moderation/calls") {
    requireModerator(request, response);
    const calls = database.prepare(`
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
    requireModerator(request, response);
    const databaseStats = statSync(databasePath);
    const activeSessions = database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE expires_at >= ?").get(Date.now()).count;
    const openReports = database.prepare("SELECT COUNT(*) AS count FROM message_reports WHERE status = 'open'").get().count;
    return respond(response, 200, {
      status: "running",
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      databaseBytes: databaseStats.size,
      databaseUpdatedAt: databaseStats.mtime.toISOString(),
      activeSessions,
      openReports
    });
  }

  if (route === "GET /api/moderation/reports") {
    requireModerator(request, response);
    const status = url.searchParams.get("status") || "open";
    if (!["open", "resolved", "dismissed", "all"].includes(status)) throw new HttpError(400, "Invalid report status filter.");
    const phoneDigits = (url.searchParams.get("phone") || "").replace(/\D/g, "");
    if (phoneDigits.length > 0 && phoneDigits.length < 3) throw new HttpError(400, "Enter at least 3 digits to search a phone number.");
    if (phoneDigits.length > 15) throw new HttpError(400, "Phone number search must be 15 digits or fewer.");
    const phonePattern = phoneDigits ? `%${phoneDigits}%` : null;
    const reports = database.prepare(`
      SELECT r.id, r.chat_id, r.message_id, r.reason, r.status, r.created_at,
        m.text AS message_text, m.attachment_name,
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
      addAudit.run(randomBytes(16).toString("hex"), report.id, "moderator", now);
      recordAdminAccess("report_viewed", report.id);
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
      senderName: report.sender_name,
      senderPhone: report.sender_phone,
      reporterName: report.reporter_name,
      reporterPhone: report.reporter_phone,
      conversation: report.conversation
    })) });
  }

  if (route === "GET /api/moderation/audit") {
    requireModerator(request, response);
    const entries = database.prepare(`
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
    const moderator = requireModerator(request, response);
    const [, reportId] = moderationReportRoute;
    const input = await readJson(request);
    if (!["resolved", "dismissed"].includes(input.status)) throw new HttpError(400, "Choose resolved or dismissed.");
    const result = database.prepare(`
      UPDATE message_reports SET status = ? WHERE id = ? AND status = 'open'
    `).run(input.status, reportId);
    if (!result.changes) throw new HttpError(404, "Open report not found.");
    database.prepare("INSERT INTO moderation_audit (id, report_id, actor_id, action, created_at) VALUES (?, ?, ?, ?, ?)").run(
      randomBytes(16).toString("hex"), reportId, moderator.role, input.status, new Date().toISOString()
    );
    recordAdminAccess(`report_${input.status}`, reportId);
    return respond(response, 200, { ok: true });
  }

  if (route === "GET /api/session" || route === "GET /api/me") {
    const session = findSession(request, response);
    if (!session || session.role !== "user") return respond(response, 200, { user: null, chats: [] });
    const user = database.prepare("SELECT id, name, email, phone FROM users WHERE id = ?").get(session.userId);
    return respond(response, 200, { user, chats: getUserChats(session.userId) });
  }

  const session = requireSession(request, response);
  if (route === "GET /api/rtc-config") return respond(response, 200, { iceServers });

  if (route === "POST /api/calls") {
    expireCalls();
    const input = await readJson(request);
    if (typeof input.chatId !== "string" || !input.chatId) throw new HttpError(400, "Choose a direct conversation to call.");
    if (!["audio", "video"].includes(input.type)) throw new HttpError(400, "Choose an audio or video call.");
    const chat = database.prepare("SELECT type FROM chats WHERE id = ?").get(input.chatId);
    if (!chat || chat.type !== "direct") throw new HttpError(400, "Calls are available only in direct conversations.");
    const members = database.prepare(`
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
    database.prepare(`
      INSERT INTO call_history (id, chat_id, caller_id, callee_id, type, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'ringing', ?)
    `).run(callId, input.chatId, session.userId, calleeId, input.type, new Date().toISOString());
    recordUserActivity(session.userId, "call.started", { type: input.type });
    const caller = database.prepare("SELECT name FROM users WHERE id = ?").get(session.userId);
    publish(calleeId, {
      type: "call",
      action: "incoming",
      callId,
      chatId: input.chatId,
      callerName: caller.name,
      callType: call.type
    });
    sendChatUpdate(call.chatId);
    return respond(response, 201, { callId });
  }

  const callRoute = url.pathname.match(/^\/api\/calls\/([a-f0-9]{32})\/(accept|decline|end|signal)$/);
  if (callRoute && request.method === "POST") {
    expireCalls();
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
      database.prepare("UPDATE call_history SET status = 'active', accepted_at = ? WHERE id = ?").run(new Date(call.acceptedAt).toISOString(), callId);
      recordUserActivity(session.userId, "call.answered", { type: call.type });
      publish(call.callerId, { type: "call", action: "accepted", callId });
      sendChatUpdate(call.chatId);
      return respond(response, 200, { ok: true });
    }
    if (action === "decline") {
      if (session.userId !== call.calleeId || call.status !== "ringing") throw new HttpError(409, "This call cannot be declined.");
      calls.delete(callId);
      database.prepare("UPDATE call_history SET status = 'declined', ended_at = ? WHERE id = ?").run(new Date().toISOString(), callId);
      recordUserActivity(session.userId, "call.declined", { type: call.type });
      publish(call.callerId, { type: "call", action: "declined", callId });
      sendChatUpdate(call.chatId);
      return respond(response, 200, { ok: true });
    }
    if (action === "end") {
      calls.delete(callId);
      const endedAt = Date.now();
      const status = call.status === "active" ? "completed" : session.userId === call.callerId ? "cancelled" : "missed";
      const durationSeconds = call.acceptedAt ? Math.max(0, Math.floor((endedAt - call.acceptedAt) / 1000)) : 0;
      database.prepare("UPDATE call_history SET status = ?, ended_at = ?, duration_seconds = ? WHERE id = ?").run(
        status, new Date(endedAt).toISOString(), durationSeconds, callId
      );
      recordUserActivity(session.userId, "call.ended", { type: call.type, status, durationSeconds });
      publish(otherId, { type: "call", action: "ended", callId, reason: status });
      sendChatUpdate(call.chatId);
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

  if (route === "GET /api/chats") return respond(response, 200, { chats: getUserChats(session.userId) });

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
    response.write(`data: ${JSON.stringify({ type: "chats", chats: getUserChats(session.userId) })}\n\n`);
    publishPresenceUpdates(session.userId);
    const heartbeat = setInterval(() => {
      const activeSession = sessions.get(session.token);
      if (activeSession) {
        activeSession.expiresAt = Date.now() + sessionLifetime;
        database.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(activeSession.expiresAt, hashSessionToken(session.token));
      }
      response.write(": heartbeat\n\n");
    }, 25000);
    response.on("close", () => {
      clearInterval(heartbeat);
      streams.delete(response);
      if (!streams.size) eventStreams.delete(session.token);
      if (!isUserOnline(session.userId)) publishPresenceUpdates(session.userId);
    });
    return;
  }

  if (route === "GET /api/contacts") {
    const contacts = database.prepare(`
      SELECT u.id, c.display_name AS name, u.phone, u.email
      FROM contacts c JOIN users u ON u.id = c.contact_id
      WHERE c.owner_id = ? ORDER BY c.display_name COLLATE NOCASE
    `).all(session.userId);
    return respond(response, 200, { contacts });
  }

  if (route === "POST /api/contacts") {
    const input = await readJson(request);
    const name = cleanText(input.name, "Name", 40);
    if (name.length < 2) throw new HttpError(400, "Name must be at least 2 characters.");
    const phone = normalizePhone(input.phone);
    const contact = database.prepare("SELECT id, name, email, phone FROM users WHERE phone = ?").get(phone);
    if (!contact) throw new HttpError(404, "No Chatter account uses that phone number yet.");
    if (contact.id === session.userId) throw new HttpError(400, "You cannot add your own number as a contact.");
    database.prepare("INSERT INTO contacts (owner_id, contact_id, display_name) VALUES (?, ?, ?) ON CONFLICT(owner_id, contact_id) DO UPDATE SET display_name = excluded.display_name").run(session.userId, contact.id, name);
    recordUserActivity(session.userId, "contact.added");
    let chat = database.prepare(`
      SELECT c.id FROM chats c JOIN chat_members a ON a.chat_id = c.id JOIN chat_members b ON b.chat_id = c.id
      WHERE c.type = 'direct' AND a.user_id = ? AND b.user_id = ?
    `).get(session.userId, contact.id);
    if (!chat) {
      const id = randomBytes(16).toString("hex");
      database.prepare("INSERT INTO chats (id, type, created_by, created_at) VALUES (?, 'direct', ?, ?)").run(id, session.userId, new Date().toISOString());
      const insertMember = database.prepare("INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)");
      insertMember.run(id, session.userId);
      insertMember.run(id, contact.id);
      chat = { id };
    }
    sendChatUpdate(chat.id);
    return respond(response, 201, { chat: chatSummary(chat.id, session.userId) });
  }

  const messageReportRoute = url.pathname.match(/^\/api\/chats\/([a-f0-9]+)\/messages\/([a-f0-9]+)\/report$/);
  if (messageReportRoute && request.method === "POST") {
    const [, chatId, messageId] = messageReportRoute;
    ensureMember(chatId, session.userId);
    const message = database.prepare("SELECT sender_id FROM messages WHERE id = ? AND chat_id = ?").get(messageId, chatId);
    if (!message) throw new HttpError(404, "Message not found in this conversation.");
    if (message.sender_id === session.userId) throw new HttpError(400, "You can only report a message sent by someone else.");
    const input = await readJson(request);
    const reason = cleanText(input.reason, "Report reason", 300);
    if (reason.length < 4) throw new HttpError(400, "Please explain why you are reporting this message.");
    const id = randomBytes(16).toString("hex");
    database.prepare(`
      INSERT INTO message_reports (id, chat_id, message_id, reporter_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, chatId, messageId, session.userId, reason, new Date().toISOString());
    database.prepare("INSERT INTO moderation_audit (id, report_id, actor_id, action, created_at) VALUES (?, ?, ?, 'reported', ?)").run(
      randomBytes(16).toString("hex"), id, session.userId, new Date().toISOString()
    );
    recordUserActivity(session.userId, "message.reported", { conversationType: database.prepare("SELECT type FROM chats WHERE id = ?").get(chatId).type });
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
    const available = database.prepare(`SELECT contact_id AS id FROM contacts WHERE owner_id = ?`).all(session.userId).map((row) => row.id);
    if (memberIds.some((id) => !available.includes(id))) throw new HttpError(403, "Groups can only include contacts you have saved.");
    const id = randomBytes(16).toString("hex");
    const createdAt = new Date().toISOString();
    database.prepare("INSERT INTO chats (id, type, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, type, name, description, session.userId, createdAt);
    const insertMember = database.prepare("INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)");
    insertMember.run(id, session.userId);
    memberIds.forEach((memberId) => insertMember.run(id, memberId));
    recordUserActivity(session.userId, "conversation.created", { type, memberCount: memberIds.length + 1 });
    sendChatUpdate(id);
    return respond(response, 201, { chat: chatSummary(id, session.userId) });
  }

  if (route === "POST /api/self-chat") {
    const existing = database.prepare("SELECT id FROM chats WHERE type = 'self' AND created_by = ?").get(session.userId);
    if (existing) return respond(response, 200, { chat: chatSummary(existing.id, session.userId) });
    const id = randomBytes(16).toString("hex");
    database.prepare("INSERT INTO chats (id, type, created_by, created_at) VALUES (?, 'self', ?, ?)").run(id, session.userId, new Date().toISOString());
    database.prepare("INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)").run(id, session.userId);
    recordUserActivity(session.userId, "conversation.created", { type: "self" });
    sendChatUpdate(id);
    return respond(response, 201, { chat: chatSummary(id, session.userId) });
  }

  const chatRoute = url.pathname.match(/^\/api\/chats\/([a-f0-9]+)(?:\/(messages|contact))?$/);
  if (chatRoute) {
    const [, chatId, resource] = chatRoute;
    ensureMember(chatId, session.userId);
    const chat = database.prepare("SELECT * FROM chats WHERE id = ?").get(chatId);

    if (request.method === "GET" && resource === "messages") return respond(response, 200, { chat: chatSummary(chatId, session.userId) });

    if (request.method === "POST" && resource === "messages") {
      const input = await readJson(request);
      const text = typeof input.text === "string" ? input.text.trim() : "";
      const attachment = input.attachment && typeof input.attachment.name === "string"
        ? { name: cleanText(input.attachment.name, "Attachment name", 180), size: cleanText(input.attachment.size || "", "Attachment size", 30) }
        : null;
      if (!text && !attachment) throw new HttpError(400, "Write a message before sending.");
      if (text.length > 4000) throw new HttpError(400, "Messages must be 4,000 characters or fewer.");
      const createdAt = new Date().toISOString();
      database.prepare("INSERT INTO messages (id, chat_id, sender_id, text, attachment_name, attachment_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomBytes(16).toString("hex"), chatId, session.userId, text, attachment?.name || null, attachment?.size || null, createdAt);
      recordUserActivity(session.userId, "message.sent", { conversationType: chat.type, hasAttachment: Boolean(attachment) });
      sendChatUpdate(chatId);
      return respond(response, 201, { message: { from: "you", text, time: new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), ...(attachment ? { attachment } : {}) } });
    }

    if (request.method === "PATCH" && resource === "contact" && chat.type === "direct") {
      const input = await readJson(request);
      const name = cleanText(input.name, "Name", 40);
      if (name.length < 2) throw new HttpError(400, "Name must be at least 2 characters.");
      const other = database.prepare("SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?").get(chatId, session.userId);
      if (!other) throw new HttpError(404, "Contact not found.");
      database.prepare("INSERT INTO contacts (owner_id, contact_id, display_name) VALUES (?, ?, ?) ON CONFLICT(owner_id, contact_id) DO UPDATE SET display_name = excluded.display_name").run(session.userId, other.user_id, name);
      recordUserActivity(session.userId, "contact.renamed");
      sendChatUpdate(chatId);
      return respond(response, 200, { chat: chatSummary(chatId, session.userId) });
    }

    if (request.method === "DELETE" && resource === "messages") {
      database.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
      recordUserActivity(session.userId, "conversation.cleared", { conversationType: chat.type });
      sendChatUpdate(chatId);
      return respond(response, 200, { chat: chatSummary(chatId, session.userId) });
    }
  }

  if (route === "PATCH /api/profile") {
    const input = await readJson(request);
    const name = cleanText(input.name, "Name", 40);
    const email = cleanText(input.email, "Email", 254).toLowerCase();
    const phone = normalizePhone(input.phone);
    if (name.length < 2) throw new HttpError(400, "Name must be at least 2 characters.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
    if (database.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id != ?").get(email, session.userId)) throw new HttpError(409, "That email is already in use.");
    if (database.prepare("SELECT 1 FROM users WHERE phone = ? AND id != ?").get(phone, session.userId)) throw new HttpError(409, "That phone number is already in use.");
    database.prepare("UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?").run(name, email, phone, session.userId);
    recordUserActivity(session.userId, "profile.updated");
    return respond(response, 200, { user: publicUser(database.prepare("SELECT id, name, email, phone FROM users WHERE id = ?").get(session.userId)) });
  }

  throw new HttpError(404, "API route not found.");
}

function serveStatic(request, response, url) {
  let requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
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
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      respond(response, 409, { error: "That account detail is already in use." });
      return;
    }
    console.error("Request failed:", error);
    respond(response, 500, { error: "The server could not complete that request." });
  }
});

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "127.0.0.1";
server.listen(port, host, () => {
  console.log(`Chatter is running at http://localhost:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const streams of eventStreams.values()) for (const stream of streams) stream.end();
    database.close();
    server.close(() => process.exit(0));
  });
}
