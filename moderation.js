const loginPanel = document.querySelector("#loginPanel");
const loginForm = document.querySelector("#moderatorLoginForm");
const loginError = document.querySelector("#loginError");
const dashboard = document.querySelector("#dashboard");
const dashboardError = document.querySelector("#dashboardError");
const reportList = document.querySelector("#reportList");
const reportStatus = document.querySelector("#reportStatus");
const reportPhoneSearch = document.querySelector("#reportPhoneSearch");
const auditList = document.querySelector("#auditList");
const activityUserSearch = document.querySelector("#activityUserSearch");
let activityFilterUserId = "";
let activityOffset = 0;
let activityTotal = 0;
const activityPageSize = 100;
const adminViews = {
  overview: document.querySelector("#overviewView"),
  users: document.querySelector("#usersView"),
  activity: document.querySelector("#activityView"),
  calls: document.querySelector("#callsView"),
  reports: document.querySelector("#reportsView"),
  audit: document.querySelector("#auditView"),
  system: document.querySelector("#systemView")
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character]);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The server returned an invalid response.");
  }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function showLogin() {
  dashboard.hidden = true;
  loginPanel.hidden = false;
}

function showDashboard() {
  loginPanel.hidden = true;
  dashboard.hidden = false;
  showView("overview");
}

function renderReports(reports) {
  if (!reports.length) {
    reportList.innerHTML = `<p class="empty-state">No reports in this filter.</p>`;
    return;
  }
  reportList.innerHTML = reports.map((report) => `
    <article class="report-card">
      <div class="report-topline">
        <div>
          <strong>${escapeHtml(report.senderName)} · ${escapeHtml(report.conversation)}</strong>
          <p class="report-meta">Sender: ${escapeHtml(report.senderPhone)} · Reported by: ${escapeHtml(report.reporterPhone)} · ${escapeHtml(new Date(report.createdAt).toLocaleString())}</p>
        </div>
        <span class="report-status ${escapeHtml(report.status)}">${escapeHtml(report.status)}</span>
      </div>
      <blockquote class="reported-message">${escapeHtml(report.messageText || report.attachmentName || "Attachment")}</blockquote>
      <p class="report-reason"><strong>Reason:</strong> ${escapeHtml(report.reason)}</p>
      ${report.status === "open" ? `
        <div class="report-actions">
          <button type="button" data-report-action="resolved" data-report-id="${escapeHtml(report.id)}">Mark resolved</button>
          <button class="secondary-button" type="button" data-report-action="dismissed" data-report-id="${escapeHtml(report.id)}">Dismiss</button>
        </div>
      ` : ""}
    </article>
  `).join("");
}

function renderAudit(entries) {
  auditList.innerHTML = entries.length ? entries.map((entry) => `
    <div class="audit-entry">
      <span>${escapeHtml(entry.action.replaceAll("_", " "))}${entry.reportId ? ` · report ${escapeHtml(entry.reportId)}` : ""}</span>
      <time datetime="${escapeHtml(entry.createdAt)}">${escapeHtml(new Date(entry.createdAt).toLocaleString())}</time>
    </div>
  `).join("") : `<p class="empty-state">No moderation activity yet.</p>`;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "No recorded activity";
}

function renderTable(headers, rows, emptyMessage) {
  if (!rows.length) return `<p class="empty-state">${escapeHtml(emptyMessage)}</p>`;
  return `<table class="data-table"><thead><tr>${headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function renderOverview(result) {
  const stats = [
    ["Users", result.totals.users],
    ["Conversations", result.totals.conversations],
    ["Messages sent", result.totals.messages],
    ["Open reports", result.totals.openReports],
    ["Calls", result.totals.calls],
    ["Completed calls", result.totals.completedCalls],
    ["Missed calls", result.totals.missedCalls],
    ["Actions · last 24h", result.totals.activity24Hours]
  ];
  document.querySelector("#overviewStats").innerHTML = stats.map(([label, value]) => `
    <article class="stat-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>
  `).join("");
  document.querySelector("#recentUsersList").innerHTML = renderTable(
    ["Name", "Email", "Phone", "Registered"],
    result.recentUsers.map((user) => `<tr><td>${escapeHtml(user.name)}</td><td>${escapeHtml(user.email)}</td><td>${escapeHtml(user.phone)}</td><td>${escapeHtml(formatDate(user.createdAt))}</td></tr>`),
    "No accounts have registered yet."
  );
}

function renderUsers(users) {
  document.querySelector("#usersList").innerHTML = renderTable(
    ["Name", "Email", "Phone", "Registered", "Last recorded activity", "Activity"],
    users.map((user) => `<tr><td>${escapeHtml(user.name)}</td><td>${escapeHtml(user.email)}</td><td>${escapeHtml(user.phone)}</td><td>${escapeHtml(formatDate(user.createdAt))}</td><td>${escapeHtml(formatDate(user.lastActiveAt))}</td><td><button class="secondary-button" type="button" data-user-activity="${escapeHtml(user.id)}">View activity</button></td></tr>`),
    "No matching accounts."
  );
}

function activityDescription(entry) {
  const labels = {
    "account.created": "Created account",
    "session.signed_in": "Signed in",
    "session.signed_out": "Signed out",
    "contact.added": "Added a contact",
    "contact.renamed": "Renamed a contact",
    "conversation.created": "Created a group or community",
    "conversation.cleared": "Cleared a conversation",
    "message.sent": "Sent a message",
    "message.reported": "Reported a message",
    "profile.updated": "Updated account profile",
    "call.started": "Started a call",
    "call.answered": "Answered a call",
    "call.declined": "Declined a call",
    "call.missed": "Missed a call",
    "call.ended": "Ended a call"
  };
  const details = [];
  if (entry.details.type) details.push(entry.details.type);
  if (entry.details.conversationType) details.push(entry.details.conversationType);
  if (entry.details.memberCount) details.push(`${entry.details.memberCount} participants`);
  if (entry.details.hasAttachment) details.push("attachment included");
  if (entry.details.status) details.push(entry.details.status);
  if (entry.details.durationSeconds) details.push(`${entry.details.durationSeconds}s`);
  return `${labels[entry.action] || entry.action}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

function renderActivity(entries) {
  document.querySelector("#activityList").innerHTML = renderTable(
    ["User", "Activity", "Time"],
    entries.map((entry) => `<tr><td>${escapeHtml(entry.userName)}${entry.userEmail ? `<small class="table-subtext">${escapeHtml(entry.userEmail)}</small>` : ""}</td><td>${escapeHtml(activityDescription(entry))}</td><td>${escapeHtml(formatDate(entry.createdAt))}</td></tr>`),
    "No user activity recorded yet."
  );
  const first = activityTotal ? activityOffset + 1 : 0;
  const last = Math.min(activityOffset + activityPageSize, activityTotal);
  document.querySelector("#activityPagination").innerHTML = `
    <span>Showing ${first}–${last} of ${activityTotal} events</span>
    <div>
      <button class="secondary-button" type="button" data-activity-page="previous" ${activityOffset === 0 ? "disabled" : ""}>Previous</button>
      <button class="secondary-button" type="button" data-activity-page="next" ${last >= activityTotal ? "disabled" : ""}>Next</button>
    </div>
  `;
}

function renderCalls(calls) {
  document.querySelector("#callsList").innerHTML = renderTable(
    ["Caller", "Recipient", "Type", "Outcome", "Duration", "Started"],
    calls.map((call) => `<tr><td>${escapeHtml(call.callerName)}<small class="table-subtext">${escapeHtml(call.callerPhone)}</small></td><td>${escapeHtml(call.calleeName)}<small class="table-subtext">${escapeHtml(call.calleePhone)}</small></td><td>${escapeHtml(call.type)}</td><td><span class="report-status ${escapeHtml(call.status)}">${escapeHtml(call.status)}</span></td><td>${escapeHtml(call.durationSeconds ? `${call.durationSeconds}s` : "—")}</td><td>${escapeHtml(formatDate(call.createdAt))}</td></tr>`),
    "No calls have been made yet."
  );
}

function renderSystem(system) {
  const details = [
    ["Service", system.status],
    ["Node.js", system.nodeVersion],
    ["Uptime", `${Math.floor(system.uptimeSeconds / 3600)}h ${Math.floor((system.uptimeSeconds % 3600) / 60)}m`],
    ["Database size", `${(system.databaseBytes / (1024 * 1024)).toFixed(2)} MB`],
    ["Database last updated", formatDate(system.databaseUpdatedAt)],
    ["Active sessions", system.activeSessions],
    ["Open reports", system.openReports]
  ];
  document.querySelector("#systemDetails").innerHTML = details.map(([label, value]) => `
    <article class="system-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>
  `).join("");
}

async function loadDashboard() {
  dashboardError.textContent = "";
  const status = encodeURIComponent(reportStatus.value);
  const phone = encodeURIComponent(reportPhoneSearch.value.trim());
  const [reportResult, openResult] = await Promise.all([
    api(`/api/moderation/reports?status=${status}&phone=${phone}`),
    api("/api/moderation/reports?status=open")
  ]);
  renderReports(reportResult.reports);
  document.querySelector("#openReportCount").textContent = String(openResult.reports.length);
}

async function loadOverview() {
  const error = document.querySelector("#overviewError");
  error.textContent = "";
  try {
    renderOverview(await api("/api/moderation/overview"));
  } catch (requestError) {
    error.textContent = requestError.message;
  }
}

async function loadUsers() {
  const error = document.querySelector("#usersError");
  error.textContent = "";
  try {
    const search = encodeURIComponent(document.querySelector("#userSearch").value.trim());
    renderUsers((await api(`/api/moderation/users?search=${search}`)).users);
  } catch (requestError) {
    error.textContent = requestError.message;
  }
}

async function loadActivity() {
  const error = document.querySelector("#activityError");
  error.textContent = "";
  try {
    const parameters = new URLSearchParams({ offset: String(activityOffset) });
    if (activityFilterUserId) parameters.set("userId", activityFilterUserId);
    else if (activityUserSearch.value.trim()) parameters.set("search", activityUserSearch.value.trim());
    const result = await api(`/api/moderation/activity?${parameters}`);
    activityTotal = result.total;
    renderActivity(result.entries);
  } catch (requestError) {
    error.textContent = requestError.message;
  }
}

async function loadCalls() {
  const error = document.querySelector("#callsError");
  error.textContent = "";
  try {
    renderCalls((await api("/api/moderation/calls")).calls);
  } catch (requestError) {
    error.textContent = requestError.message;
  }
}

async function loadSystem() {
  const error = document.querySelector("#systemError");
  error.textContent = "";
  try {
    renderSystem(await api("/api/moderation/system"));
  } catch (requestError) {
    error.textContent = requestError.message;
  }
}

async function loadAudit() {
  const result = await api("/api/moderation/audit");
  renderAudit(result.entries);
}

function showView(view) {
  for (const [viewName, element] of Object.entries(adminViews)) {
    element.hidden = viewName !== view;
  }
  document.querySelectorAll("[data-admin-view]").forEach((button) => {
    const active = button.dataset.adminView === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  try {
    await api("/api/moderation/login", {
      method: "POST",
      body: JSON.stringify({ password: document.querySelector("#moderatorPassword").value })
    });
    document.querySelector("#moderatorPassword").value = "";
    showDashboard();
    await Promise.all([loadOverview(), loadDashboard(), loadAudit()]);
  } catch (error) {
    loginError.textContent = error.message;
  }
});

document.querySelector("#refreshReportsButton").addEventListener("click", async () => {
  try {
    await loadDashboard();
  } catch (error) {
    dashboardError.textContent = error.message;
  }
});

document.querySelector("#reportSearchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await loadDashboard();
  } catch (error) {
    dashboardError.textContent = error.message;
  }
});

reportStatus.addEventListener("change", async () => {
  try {
    await loadDashboard();
  } catch (error) {
    dashboardError.textContent = error.message;
  }
});

document.querySelector("#refreshOverviewButton").addEventListener("click", loadOverview);
document.querySelector("#refreshUsersButton").addEventListener("click", loadUsers);
document.querySelector("#refreshActivityButton").addEventListener("click", loadActivity);
document.querySelector("#activitySearchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  activityFilterUserId = "";
  activityOffset = 0;
  loadActivity();
});
document.querySelector("#clearActivitySearchButton").addEventListener("click", () => {
  activityFilterUserId = "";
  activityUserSearch.value = "";
  activityOffset = 0;
  loadActivity();
});
document.querySelector("#activityPagination").addEventListener("click", (event) => {
  const button = event.target.closest("[data-activity-page]");
  if (!button || button.disabled) return;
  activityOffset += button.dataset.activityPage === "next" ? activityPageSize : -activityPageSize;
  loadActivity();
});
document.querySelector("#usersList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-user-activity]");
  if (!button) return;
  activityFilterUserId = button.dataset.userActivity;
  activityOffset = 0;
  activityUserSearch.value = "";
  showView("activity");
  loadActivity();
});
document.querySelector("#refreshCallsButton").addEventListener("click", loadCalls);
document.querySelector("#refreshSystemButton").addEventListener("click", loadSystem);
document.querySelector("#userSearchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  loadUsers();
});

document.querySelectorAll("[data-admin-view]").forEach((button) => {
  button.addEventListener("click", async () => {
    const view = button.dataset.adminView;
    showView(view);
    try {
      if (view === "overview") await loadOverview();
      if (view === "users") await loadUsers();
      if (view === "activity") await loadActivity();
      if (view === "calls") await loadCalls();
      if (view === "reports") await loadDashboard();
      if (view === "audit") await loadAudit();
      if (view === "system") await loadSystem();
    } catch (error) {
      dashboardError.textContent = error.message;
    }
  });
});

reportList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-report-action]");
  if (!button) return;
  button.disabled = true;
  dashboardError.textContent = "";
  try {
    await api(`/api/moderation/reports/${button.dataset.reportId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: button.dataset.reportAction })
    });
    await loadDashboard();
  } catch (error) {
    dashboardError.textContent = error.message;
    button.disabled = false;
  }
});

document.querySelector("#moderatorLogoutButton").addEventListener("click", async () => {
  try {
    await api("/api/moderation/logout", { method: "POST" });
    showLogin();
  } catch (error) {
    dashboardError.textContent = error.message;
  }
});

async function startModerationPage() {
  try {
    const result = await api("/api/moderation/session");
    if (!result.authenticated) {
      showLogin();
      return;
    }
    showDashboard();
    await Promise.all([loadOverview(), loadDashboard(), loadAudit()]);
  } catch (error) {
    showLogin();
    loginError.textContent = error.message;
  }
}

startModerationPage();
