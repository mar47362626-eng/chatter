const seedChats = [
  {
    id: "lena",
    name: "Lena Brooks",
    initials: "LB",
    avatar: "avatar-lena",
    online: true,
    status: "online now",
    time: "10:42",
    preview: "That sounds like a perfect plan ✨",
    unread: 2,
    group: false,
    date: "Today",
    messages: [
      { from: "them", text: "Hey Alex! How's your week going?", time: "10:31" },
      { from: "you", text: "Pretty good! Finally got a chance to slow down a little. How about yours?", time: "10:34" },
      { from: "them", text: "Same here 😊 I've been meaning to ask — are you free this weekend?", time: "10:37" },
      { from: "you", text: "I am! What did you have in mind?", time: "10:39" },
      { from: "them", text: "That sounds like a perfect plan ✨", time: "10:42" }
    ]
  },
  {
    id: "marcus",
    name: "Marcus Chen",
    initials: "MC",
    avatar: "avatar-marcus",
    online: true,
    status: "online now",
    time: "10:18",
    preview: "I'll send it over in a bit.",
    unread: 0,
    group: false,
    date: "Today",
    messages: [
      { from: "them", text: "Morning! Did you get a chance to look at the photos from yesterday?", time: "10:11" },
      { from: "you", text: "Just looked — they turned out so good!", time: "10:14" },
      { from: "them", text: "I'll send it over in a bit.", time: "10:18" }
    ]
  },
  {
    id: "weekend",
    name: "Weekend Crew",
    initials: "WC",
    avatar: "avatar-team",
    online: false,
    status: "5 members",
    time: "9:56",
    preview: "Sofia: I can bring snacks!",
    unread: 3,
    group: true,
    date: "Today",
    messages: [
      { from: "them", sender: "Jamie", text: "Saturday picnic at the park? Weather looks amazing ☀️", time: "9:48" },
      { from: "you", text: "I'm in! I'll bring a blanket.", time: "9:52" },
      { from: "them", sender: "Sofia", text: "I can bring snacks!", time: "9:56" }
    ]
  },
  {
    id: "sofia",
    name: "Sofia Rivera",
    initials: "SR",
    avatar: "avatar-sofia",
    online: false,
    status: "last seen today at 9:20",
    time: "9:20",
    preview: "Voice message · 0:18",
    unread: 0,
    group: false,
    date: "Yesterday",
    messages: [
      { from: "them", text: "Thanks again for helping me out yesterday. You're the best!", time: "9:14" },
      { from: "you", text: "Anytime! Let me know how it goes 💛", time: "9:17" },
      { from: "them", text: "Voice message · 0:18", time: "9:20" }
    ]
  },
  {
    id: "jamie",
    name: "Jamie Park",
    initials: "JP",
    avatar: "avatar-jamie",
    online: false,
    status: "last seen yesterday",
    time: "Yesterday",
    preview: "You: Absolutely, see you there!",
    unread: 0,
    group: false,
    date: "Yesterday",
    messages: [
      { from: "them", text: "The new coffee place on Willow opened today. Want to check it out?", time: "Yesterday" },
      { from: "you", text: "Absolutely, see you there!", time: "Yesterday" }
    ]
  },
  {
    id: "design",
    name: "Design buddies",
    initials: "DB",
    avatar: "avatar-design",
    online: false,
    status: "4 members",
    time: "Mon",
    preview: "Marcus: Nice work, everyone 👏",
    unread: 0,
    group: true,
    date: "Monday",
    messages: [
      { from: "them", sender: "Sofia", text: "Just shared the latest mockups in the folder.", time: "Monday" },
      { from: "them", sender: "Marcus", text: "Nice work, everyone 👏", time: "Monday" }
    ]
  }
];

let chats = [];
let profile = null;
let activeId = null;
let activeFilter = "all";
let query = "";
let toastTimer;
let messageSearchQuery = "";
let messageSearchMatches = [];
let currentMessageMatch = 0;
let pendingReportMessageId = null;
let callMediaStream = null;
let screenShareStream = null;
let activeCall = null;
let incomingCall = null;
let callStartedAt = 0;
let callDurationTimer = 0;
let callDisconnectTimer = 0;
let microphoneEnabled = true;
let cameraEnabled = true;

const appShell = document.querySelector(".app-shell");
const conversationList = document.querySelector("#conversationList");
const headerPerson = document.querySelector("#headerPerson");
const chatIntro = document.querySelector("#chatIntro");
const messages = document.querySelector("#messages");
const messageArea = document.querySelector("#messageArea");
const messageForm = document.querySelector("#messageForm");
const messageInput = document.querySelector("#messageInput");
const searchInput = document.querySelector("#searchInput");
const emojiPopover = document.querySelector("#emojiPopover");
const toast = document.querySelector("#toast");
const authScreen = document.querySelector("#authScreen");
const registerForm = document.querySelector("#registerForm");
const loginForm = document.querySelector("#loginForm");
const sidebar = document.querySelector("#sidebar");
const newChatView = document.querySelector("#newChatView");
const newChatSearchInput = document.querySelector("#newChatSearchInput");
let newChatQuery = "";
let groupType = "group";

async function apiRequest(path, options = {}) {
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character]);
}

function activeChat() {
  return chats.find((chat) => chat.id === activeId) || null;
}

function applyProfile() {
  const name = profile?.name || "Alex Morgan";
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "A";
  const selfChat = chats.find((chat) => chat.self);
  if (selfChat) {
    selfChat.name = `${name} (You)`;
    selfChat.initials = initials;
  }
  document.querySelector("#profileName").textContent = name;
  document.querySelector("#profileAvatar").textContent = initials;
  document.querySelector("#selfContactName").textContent = `${name} (You)`;
  document.querySelector("#selfContactAvatar").textContent = initials;
  document.querySelector("#profileContact").textContent = profile?.email
    ? `${profile.email} · ${profile.phone.slice(-4)}`
    : "Email and phone account";
}

function openChatApp() {
  applyProfile();
  authScreen.hidden = true;
  appShell.hidden = false;
}

function renderChatList() {
  const filtered = chats.filter((chat) => {
    const matchesFilter = activeFilter === "all" ||
      (activeFilter === "unread" && chat.unread > 0) ||
      (activeFilter === "groups" && chat.group);
    const matchesQuery = `${chat.name} ${chat.preview}`.toLowerCase().includes(query.toLowerCase());
    return matchesFilter && matchesQuery;
  });

  conversationList.innerHTML = filtered.length ? filtered.map((chat) => `
    <button class="conversation ${chat.id === activeId ? "is-selected" : ""}" type="button" role="listitem" data-chat-id="${escapeHtml(chat.id)}" aria-current="${chat.id === activeId ? "true" : "false"}">
      <span class="avatar ${escapeHtml(chat.avatar)} ${chat.group ? "group-avatar" : ""} ${chat.online ? "online" : ""}" aria-label="${chat.online ? "Online" : "Offline"}">${escapeHtml(chat.initials)}</span>
      <span class="conversation-copy">
        <span class="conversation-topline"><span class="conversation-name">${escapeHtml(chat.name)}</span><span class="conversation-time">${escapeHtml(chat.time)}</span></span>
        <span class="conversation-preview-row"><span class="conversation-preview">${escapeHtml(chat.preview)}</span>${chat.unread ? `<span class="unread-badge">${chat.unread}</span>` : ""}</span>
      </span>
    </button>
  `).join("") : `<div class="empty-list">${query || activeFilter !== "all" ? "No conversations found.<br />Try another search or filter." : "No conversations yet.<br />Use + to find or add someone."}</div>`;

  document.querySelector("#allCount").textContent = chats.length;
  document.querySelector("#unreadCount").textContent = chats.filter((chat) => chat.unread > 0).length;
}

function contactUsername(chat) {
  return chat.username || `@${chat.id.replace(/^contact-/, "")}`;
}

function renderNewChatContacts() {
  const contacts = chats
    .filter((chat) => !chat.group && !chat.self)
    .sort((left, right) => left.name.localeCompare(right.name));
  const matches = contacts.filter((chat) => {
    const searchText = `${chat.name} ${chat.phone || ""} ${contactUsername(chat)} ${chat.id}`.toLowerCase();
    return searchText.includes(newChatQuery.toLowerCase());
  });
  document.querySelector("#newChatContactCount").textContent = contacts.length ? String(matches.length) : "";
  document.querySelector("#newChatContactList").innerHTML = matches.map((chat) => `
    <button class="new-chat-contact" type="button" data-new-chat-id="${escapeHtml(chat.id)}">
      <span class="new-chat-avatar presence-avatar ${escapeHtml(chat.avatar)} ${chat.online ? "online" : ""}" aria-label="${chat.online ? "Online" : "Offline"}">${escapeHtml(chat.initials)}</span>
      <span class="new-chat-contact-copy">
        <strong>${escapeHtml(chat.name)}</strong>
        <span>${escapeHtml(chat.phone || contactUsername(chat))}</span>
      </span>
    </button>
  `).join("");
  document.querySelector("#newChatEmpty").hidden = matches.length > 0;
}

function openNewChatView() {
  newChatView.hidden = false;
  sidebar.classList.add("new-chat-mode");
  newChatSearchInput.value = "";
  newChatQuery = "";
  renderNewChatContacts();
  newChatSearchInput.focus();
}

function closeNewChatView() {
  sidebar.classList.remove("new-chat-mode");
  newChatView.hidden = true;
  newChatSearchInput.value = "";
  newChatQuery = "";
}

function renderHeader(chat) {
  if (!chat) {
    headerPerson.innerHTML = "";
    chatIntro.innerHTML = `<strong>Welcome to Chatter</strong><span>Select a conversation or start a new chat.</span>`;
    return;
  }
  const onlineLabel = chat.online
    ? `<span class="status-dot"></span>Online`
    : chat.phone ? `Contact · ${escapeHtml(chat.phone)}` : escapeHtml(chat.status);
  headerPerson.innerHTML = `
    <span class="avatar ${escapeHtml(chat.avatar)} ${chat.group ? "group-avatar" : ""} ${chat.online ? "online" : ""}">${escapeHtml(chat.initials)}</span>
    <span class="header-copy"><strong>${escapeHtml(chat.name)}</strong><span>${onlineLabel}</span></span>
  `;
  const memberCount = Number.parseInt(chat.status, 10);
  const contactCount = Number.isFinite(memberCount) ? Math.max(memberCount - 1, 0) : chat.status.replace(" members", "");
  const groupDescription = chat.community
    ? `Community · ${chat.status}`
    : `A group with ${contactCount} ${contactCount === 1 ? "contact" : "contacts"}`;
  chatIntro.innerHTML = `
    <span class="avatar intro-avatar ${escapeHtml(chat.avatar)} ${chat.group ? "group-avatar" : ""}">${escapeHtml(chat.initials)}</span>
    <strong>${escapeHtml(chat.name)}</strong>
    <span>${chat.phone ? `Saved contact · ${escapeHtml(chat.phone)}` : chat.group ? escapeHtml(groupDescription) : chat.self ? "Your personal notes and messages" : "You’re connected on Chatter"}</span>
    <span class="intro-badge"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 13 3.4v4.1c0 3-2.1 5.6-5 7-2.9-1.4-5-4-5-7V3.4l5-1.9Z" /><path d="m5.8 7.8 1.5 1.5 3-3.2" /></svg> Messages are private</span>
  `;
}

function renderMessages() {
  const chat = activeChat();
  renderHeader(chat);
  if (!chat) {
    chatIntro.hidden = false;
    chatIntro.innerHTML = `<strong>Welcome to Chatter</strong><span>Select a conversation or start a new chat.</span>`;
    messages.innerHTML = "";
    document.querySelector("#messageSearchBar").hidden = true;
    document.querySelector("#messageForm").hidden = true;
    return;
  }
  chatIntro.hidden = chat.messages.length > 0;
  document.querySelector("#messageForm").hidden = false;
  messageSearchMatches = messageSearchQuery
    ? chat.messages.map((message, index) => message.text?.toLowerCase().includes(messageSearchQuery.toLowerCase()) ? index : -1).filter((index) => index >= 0)
    : [];
  if (messageSearchMatches.length && currentMessageMatch >= messageSearchMatches.length) currentMessageMatch = 0;
  let dateShown = false;
  messages.innerHTML = chat.messages.map((message, messageIndex) => {
    const dateDivider = !dateShown ? `<div class="date-divider"><span>${escapeHtml(chat.date)}</span></div>` : "";
    dateShown = true;
    const isOutgoing = message.from === "you";
    const matchIndex = messageSearchMatches.indexOf(messageIndex);
    const hasMatch = matchIndex >= 0;
    const isCurrentMatch = hasMatch && matchIndex === currentMessageMatch;
    const sender = message.sender ? `<span class="message-sender">${escapeHtml(message.sender)}</span>` : "";
    let messageText = escapeHtml(message.text || "");
    if (messageSearchQuery && message.text) {
      const escapedQuery = messageSearchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      messageText = messageText.replace(new RegExp(`(${escapedQuery})`, "gi"), '<mark class="message-highlight">$1</mark>');
    }
    const callLabel = message.call?.type === "audio" ? "Voice call" : "Video call";
    const callStatus = message.call?.status === "ringing"
      ? message.call.direction === "outgoing" ? "Calling…" : "Incoming call"
      : message.call?.status === "completed"
        ? `Answered · ${formatCallDuration(message.call.durationSeconds)}`
        : message.call?.status === "missed"
          ? message.call.direction === "incoming" ? "Missed call" : "No answer"
          : message.call?.status === "declined"
            ? "Declined"
            : message.call?.status === "cancelled"
              ? message.call.direction === "incoming" ? "Missed call" : "No answer"
              : message.call?.status === "active" ? "Call in progress" : "";
    const attachment = message.call ? `
      <span class="call-log-bubble ${message.call.status === "missed" ? "is-missed" : ""}">
        <span class="call-log-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7.2 3.8 10 7.5 8.3 9.2a14 14 0 0 0 6.5 6.5l1.7-1.7 3.7 2.8-.8 3a1.5 1.5 0 0 1-1.7 1.1A18.8 18.8 0 0 1 3.1 6.3a1.5 1.5 0 0 1 1.1-1.7l3-.8Z" /></svg></span>
        <span class="call-log-details"><strong>${callLabel}</strong><span>${callStatus}</span></span>
      </span>
    ` : message.attachment ? `
      <span class="bubble-attachment"><span class="file-icon"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4M7.5 11h5M7.5 14h5" /></svg></span>
      <span class="file-details"><strong>${escapeHtml(message.attachment.name)}</strong><span>${escapeHtml(message.attachment.size)}</span></span></span>
    ` : messageText;
    return `${dateDivider}
      <div class="message-row ${isOutgoing ? "outgoing" : ""} ${message.call ? "call-log-row" : ""} ${hasMatch ? "has-search-match" : ""} ${isCurrentMatch ? "is-current-search-match" : ""}" data-message-index="${messageIndex}">
        ${!isOutgoing ? `<span class="avatar message-avatar ${escapeHtml(chat.avatar)} ${chat.group ? "group-avatar" : ""}">${escapeHtml(message.sender ? message.sender.slice(0, 1) : chat.initials)}</span>` : ""}
        <span class="message-stack">${sender}<span class="bubble ${message.call ? "call-log-bubble-container" : ""}">${attachment}</span><span class="message-meta">${escapeHtml(message.time)}${isOutgoing && !message.call ? '<span class="read-check" aria-label="Read">✓✓</span>' : ""}</span>${!isOutgoing && message.id && !message.call ? `<button class="message-report-button" type="button" data-report-message-id="${escapeHtml(message.id)}">Report</button>` : ""}</span>
      </div>`;
  }).join("");
  renderMessageSearchCount();
  messageArea.scrollTop = messageArea.scrollHeight;
}

function renderMessageSearchCount() {
  const count = document.querySelector("#searchMatchCount");
  if (!messageSearchQuery) {
    count.textContent = "";
  } else if (messageSearchMatches.length) {
    count.textContent = `${currentMessageMatch + 1} of ${messageSearchMatches.length}`;
  } else {
    count.textContent = "0 results";
  }
}

function goToMessageMatch(direction) {
  if (!messageSearchMatches.length) return;
  currentMessageMatch = (currentMessageMatch + direction + messageSearchMatches.length) % messageSearchMatches.length;
  renderMessages();
  document.querySelector(`[data-message-index="${messageSearchMatches[currentMessageMatch]}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function updateChatContactDetails() {
  const chat = activeChat();
  if (!chat) return;
  document.querySelector("#chatContactAvatar").className = `new-chat-avatar ${chat.avatar}`;
  document.querySelector("#chatContactAvatar").textContent = chat.initials;
  document.querySelector("#chatContactTitle").textContent = chat.name;
  document.querySelector("#chatContactPhone").textContent = chat.phone || (chat.self ? "Your personal chat" : chat.group ? `${chat.status}${chat.community ? " · Community" : " · Group"}` : "Chatter contact");
  document.querySelector("#chatContactDescription").textContent = chat.description || (chat.phone
    ? "This number is saved in your Chatter contacts."
    : chat.group ? "Group information is saved with this conversation." : "Contact information is saved in Chatter.");
  document.querySelector("#editContactFromDetails").hidden = chat.group || chat.self;
}

function openContactDetails() {
  closeChatOptionsMenu();
  updateChatContactDetails();
  document.querySelector("#chatContactDialog").hidden = false;
}

function openEditContact() {
  const chat = activeChat();
  if (!chat || chat.group || chat.self) return;
  document.querySelector("#editChatContactName").value = chat.name;
  document.querySelector("#editChatContactPhone").value = chat.phone || "";
  document.querySelector("#editChatContactError").textContent = "";
  document.querySelector("#chatContactDialog").hidden = true;
  document.querySelector("#editChatContactDialog").hidden = false;
  document.querySelector("#editChatContactName").focus();
}

function closeChatOptionsMenu() {
  const menu = document.querySelector("#chatOptionsMenu");
  menu.hidden = true;
  document.querySelector("#chatMoreButton").setAttribute("aria-expanded", "false");
}

function releaseCallMedia() {
  if (callDurationTimer) window.clearInterval(callDurationTimer);
  callDurationTimer = 0;
  if (callDisconnectTimer) window.clearTimeout(callDisconnectTimer);
  callDisconnectTimer = 0;
  const peerConnection = activeCall?.peerConnection;
  if (peerConnection) {
    peerConnection.onicecandidate = null;
    peerConnection.ontrack = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
  }
  for (const stream of [screenShareStream, callMediaStream]) {
    stream?.getTracks().forEach((track) => track.stop());
  }
  screenShareStream = null;
  callMediaStream = null;
  callStartedAt = 0;
  const video = document.querySelector("#callPreviewVideo");
  video.pause();
  video.srcObject = null;
  video.hidden = true;
  const remoteVideo = document.querySelector("#remoteCallVideo");
  remoteVideo.pause();
  remoteVideo.srcObject = null;
  remoteVideo.hidden = true;
  const remoteAudio = document.querySelector("#remoteCallAudio");
  remoteAudio.pause();
  remoteAudio.srcObject = null;
}

function closeCallUi() {
  activeCall = null;
  incomingCall = null;
  releaseCallMedia();
  document.querySelector("#callSessionDialog").hidden = true;
  document.querySelector("#incomingCallDialog").hidden = true;
}

async function endCall() {
  const callId = activeCall?.id;
  if (callId) {
    try {
      await apiRequest(`/api/calls/${encodeURIComponent(callId)}/end`, { method: "POST" });
    } catch (error) {
      console.error("Could not notify the other person that the call ended:", error);
      showToast(`Call ended on this device, but the other person may not be notified: ${error.message}`);
    }
  }
  closeCallUi();
}

function formatCallDuration(seconds) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function callMediaErrorMessage(error, type) {
  if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
    return "Allow microphone access in your browser. Video calls also need camera access.";
  }
  if (error.name === "NotFoundError") {
    return type === "video"
      ? "No compatible microphone or camera was found. Check your devices or try an audio call."
      : "No compatible microphone was found. Check your device and try again.";
  }
  if (error.name === "AbortError" || error.name === "NotReadableError") {
    return type === "video"
      ? "The camera timed out or is being used by another app or tab. Close other camera apps/tabs, then try video again or choose Audio call."
      : "The microphone could not start or is being used by another app. Close other audio apps/tabs and try again.";
  }
  if (error.name === "SecurityError") {
    return "Camera and microphone access requires localhost or a secure HTTPS connection.";
  }
  return "The microphone or camera could not be opened. Check your device and browser permissions, then try again.";
}

function startCallDurationTimer() {
  if (callStartedAt) return;
  callStartedAt = Date.now();
  callDurationTimer = window.setInterval(() => {
    document.querySelector("#callDuration").textContent = formatCallDuration(Math.floor((Date.now() - callStartedAt) / 1000));
  }, 1000);
}

async function sendCallSignal(call, signalType, data) {
  if (!call.id || activeCall !== call) return;
  await apiRequest(`/api/calls/${encodeURIComponent(call.id)}/signal`, {
    method: "POST",
    body: JSON.stringify({ signalType, data })
  });
}

async function createPeerConnection(call) {
  const config = await apiRequest("/api/rtc-config");
  if (activeCall !== call) throw new Error("The call ended before a connection could be made.");
  const peerConnection = new RTCPeerConnection({ iceServers: config.iceServers });
  call.peerConnection = peerConnection;
  for (const track of callMediaStream.getTracks()) peerConnection.addTrack(track, callMediaStream);

  peerConnection.onicecandidate = (event) => {
    if (!event.candidate || activeCall !== call) return;
    sendCallSignal(call, "candidate", event.candidate.toJSON()).catch((error) => {
      console.error("Could not send call network information:", error);
      showToast(`Call connection issue: ${error.message}`);
    });
  };
  peerConnection.ontrack = (event) => {
    if (activeCall !== call) return;
    const remoteStream = event.streams[0];
    if (!remoteStream) return;
    const remoteAudio = document.querySelector("#remoteCallAudio");
    if (remoteAudio.srcObject !== remoteStream) {
      remoteAudio.srcObject = remoteStream;
      remoteAudio.play().catch((error) => {
        if (error.name === "AbortError" || activeCall !== call) return;
        console.warn("Could not play the other person's audio:", error);
        showToast(error.name === "NotAllowedError"
          ? "Click the call window to allow audio playback."
          : "The other person's audio could not be played.");
      });
    }
    const remoteVideo = document.querySelector("#remoteCallVideo");
    if (call.type === "video" && event.track.kind === "video") {
      const needsPlayback = remoteVideo.srcObject !== remoteStream;
      if (needsPlayback) remoteVideo.srcObject = remoteStream;
      remoteVideo.hidden = false;
      document.querySelector("#callPreviewVideo").hidden = false;
      document.querySelector("#audioCallAvatar").hidden = true;
      if (needsPlayback) {
        remoteVideo.play().catch((error) => {
          if (error.name === "AbortError" || activeCall !== call) return;
          console.warn("Could not play the other person's video:", error);
          showToast("The other person's video could not be displayed.");
        });
      }
    }
  };
  peerConnection.onconnectionstatechange = () => {
    if (activeCall !== call) return;
    const status = document.querySelector("#callSessionStatus");
    if (peerConnection.connectionState === "connected") {
      if (callDisconnectTimer) window.clearTimeout(callDisconnectTimer);
      callDisconnectTimer = 0;
      status.textContent = `Connected with ${call.peerName}.`;
      document.querySelector("#callPreviewCaption").textContent = "Call connected.";
      startCallDurationTimer();
    } else if (peerConnection.connectionState === "disconnected") {
      status.textContent = "Connection interrupted. Trying to reconnect…";
      if (!callDisconnectTimer) {
        callDisconnectTimer = window.setTimeout(() => {
          callDisconnectTimer = 0;
          if (activeCall === call && peerConnection.connectionState !== "connected") {
            showToast("The call ended because the connection was lost.");
            endCall();
          }
        }, 15000);
      }
    } else if (peerConnection.connectionState === "failed") {
      if (callDisconnectTimer) window.clearTimeout(callDisconnectTimer);
      callDisconnectTimer = 0;
      status.textContent = "Could not connect. Check the network and try again.";
      showToast("The call could not connect. A TURN server may be needed on this network.");
      endCall();
    }
  };
  return peerConnection;
}

function showCallSession(call, outgoing) {
  document.querySelector("#callChoiceDialog").hidden = true;
  document.querySelector("#incomingCallDialog").hidden = true;
  document.querySelector("#callSessionTitle").textContent = `${call.type === "video" ? "Video" : "Audio"} call with ${call.peerName}`;
  document.querySelector("#callSessionStatus").textContent = outgoing
    ? `Calling ${call.peerName}…`
    : "Connecting…";
  document.querySelector("#callPreviewCaption").textContent = outgoing
    ? "Waiting for the other person to answer…"
    : "Joining the call…";
  const avatar = document.querySelector("#audioCallAvatar");
  avatar.textContent = call.peerName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
  avatar.hidden = call.type === "video";
  document.querySelector("#callPreviewVideo").hidden = call.type !== "video";
  document.querySelector("#remoteCallVideo").hidden = true;
  document.querySelector("#toggleCameraButton").hidden = call.type !== "video";
  document.querySelector("#shareScreenButton").hidden = call.type !== "video";
  document.querySelector("#toggleMicrophoneButton").textContent = "Mute mic";
  document.querySelector("#toggleCameraButton").textContent = "Turn camera off";
  document.querySelector("#shareScreenButton").textContent = "Share screen";
  document.querySelector("#endCallButton").querySelector("span").textContent = "End call";
  document.querySelector("#callDuration").textContent = "00:00";
  document.querySelector("#callSessionDialog").hidden = false;

  if (call.type === "video") {
    const video = document.querySelector("#callPreviewVideo");
    video.srcObject = callMediaStream;
    video.play().catch((error) => {
      console.warn("Could not play the local camera preview:", error);
      showToast("Your camera preview could not be displayed.");
    });
  }
}

async function startCall(type) {
  const chat = activeChat();
  const error = document.querySelector("#callChoiceError");
  error.textContent = "";
  if (!chat || chat.group || chat.self || !chat.contactId) {
    error.textContent = "Calls are available only in a one-to-one conversation.";
    return;
  }
  if (activeCall) {
    error.textContent = "End your current call before starting another.";
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    error.textContent = "Camera and microphone access requires localhost or a secure HTTPS connection.";
    return;
  }
  const audioButton = document.querySelector("#startAudioCallButton");
  const videoButton = document.querySelector("#startVideoCallButton");
  audioButton.disabled = true;
  videoButton.disabled = true;
  audioButton.querySelector("strong").textContent = type === "audio" ? "Requesting microphone…" : "Audio call";
  videoButton.querySelector("strong").textContent = type === "video" ? "Requesting camera…" : "Video call";
  try {
    callMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: type === "video" });
  } catch (reason) {
    console.warn("Could not open call media:", reason);
    error.textContent = callMediaErrorMessage(reason, type);
    audioButton.disabled = false;
    videoButton.disabled = false;
    audioButton.querySelector("strong").textContent = "Audio call";
    videoButton.querySelector("strong").textContent = "Video call";
    return;
  }

  microphoneEnabled = true;
  cameraEnabled = true;
  activeCall = {
    id: null,
    chatId: chat.id,
    type,
    role: "caller",
    peerName: chat.name,
    peerConnection: null,
    pendingCandidates: []
  };
  try {
    const result = await apiRequest("/api/calls", {
      method: "POST",
      body: JSON.stringify({ chatId: chat.id, type })
    });
    activeCall.id = result.callId;
    showCallSession(activeCall, true);
  } catch (requestError) {
    closeCallUi();
    error.textContent = requestError.message;
  } finally {
    audioButton.disabled = false;
    videoButton.disabled = false;
    audioButton.querySelector("strong").textContent = "Audio call";
    videoButton.querySelector("strong").textContent = "Video call";
  }
}

async function declineIncomingCall() {
  if (!incomingCall) return;
  const call = incomingCall;
  try {
    await apiRequest(`/api/calls/${encodeURIComponent(call.callId)}/decline`, { method: "POST" });
    incomingCall = null;
    document.querySelector("#incomingCallDialog").hidden = true;
  } catch (error) {
    console.error("Could not decline the incoming call:", error);
    document.querySelector("#incomingCallError").textContent = error.message;
  }
}

async function acceptIncomingCall() {
  if (!incomingCall || activeCall) return;
  const invitation = incomingCall;
  const answerButton = document.querySelector("#acceptCallButton");
  answerButton.disabled = true;
  document.querySelector("#incomingCallError").textContent = "";
  try {
    callMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: invitation.callType === "video"
    });
    microphoneEnabled = true;
    cameraEnabled = true;
    activeCall = {
      id: invitation.callId,
      chatId: invitation.chatId,
      type: invitation.callType,
      role: "callee",
      peerName: invitation.callerName,
      peerConnection: null,
      pendingCandidates: []
    };
    await createPeerConnection(activeCall);
    await apiRequest(`/api/calls/${encodeURIComponent(activeCall.id)}/accept`, { method: "POST" });
    incomingCall = null;
    showCallSession(activeCall, false);
  } catch (error) {
    console.error("Could not answer the incoming call:", error);
    const mediaError = callMediaErrorMessage(error, invitation.callType);
    if (activeCall?.id === invitation.callId) {
      try {
        await apiRequest(`/api/calls/${encodeURIComponent(invitation.callId)}/end`, { method: "POST" });
      } catch (endError) {
        console.error("Could not close the unanswered call:", endError);
      }
      closeCallUi();
    } else {
      try {
        await apiRequest(`/api/calls/${encodeURIComponent(invitation.callId)}/decline`, { method: "POST" });
      } catch (declineError) {
        console.error("Could not decline the call after media access failed:", declineError);
      }
      incomingCall = null;
      document.querySelector("#incomingCallDialog").hidden = true;
    }
    showToast(`Could not answer the call: ${mediaError}`);
  } finally {
    answerButton.disabled = false;
  }
}

async function receiveCallSignal(event) {
  const call = activeCall;
  const peerConnection = call?.peerConnection;
  if (!call || call.id !== event.callId || !peerConnection) return;
  if (event.signalType === "candidate") {
    if (peerConnection.remoteDescription) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(event.data));
    } else {
      call.pendingCandidates.push(event.data);
    }
    return;
  }
  if (event.signalType === "offer" && call.role === "callee") {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(event.data));
    for (const candidate of call.pendingCandidates.splice(0)) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    await sendCallSignal(call, "answer", peerConnection.localDescription.toJSON());
  } else if (event.signalType === "answer" && call.role === "caller") {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(event.data));
    for (const candidate of call.pendingCandidates.splice(0)) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }
}

async function handleCallEvent(event) {
  if (event.action === "incoming") {
    if (activeCall || incomingCall) {
      try {
        await apiRequest(`/api/calls/${encodeURIComponent(event.callId)}/decline`, { method: "POST" });
      } catch (error) {
        console.error("Could not reject a second incoming call:", error);
      }
      return;
    }
    incomingCall = event;
    document.querySelector("#incomingCallTitle").textContent = `${event.callerName} is calling`;
    document.querySelector("#incomingCallDescription").textContent = `${event.callType === "video" ? "Video" : "Audio"} call`;
    document.querySelector("#incomingCallError").textContent = "";
    document.querySelector("#incomingCallDialog").hidden = false;
    return;
  }
  if (event.action === "accepted" && activeCall?.id === event.callId && activeCall.role === "caller") {
    try {
      const peerConnection = await createPeerConnection(activeCall);
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      await sendCallSignal(activeCall, "offer", peerConnection.localDescription.toJSON());
      document.querySelector("#callSessionStatus").textContent = `Connecting with ${activeCall.peerName}…`;
    } catch (error) {
      console.error("Could not establish the call:", error);
      showToast(`Could not establish the call: ${error.message}`);
      await endCall();
    }
    return;
  }
  if (event.action === "signal") {
    try {
      await receiveCallSignal(event);
    } catch (error) {
      console.error("Could not process call connection data:", error);
      showToast(`Call connection issue: ${error.message}`);
      await endCall();
    }
    return;
  }
  if (event.action === "declined" && activeCall?.id === event.callId) {
    closeCallUi();
    showToast("The other person declined the call.");
    return;
  }
  if (event.action === "ended") {
    if (activeCall?.id === event.callId) {
      closeCallUi();
      showToast("The call has ended.");
    } else if (incomingCall?.callId === event.callId) {
      closeCallUi();
      showToast("The incoming call has ended.");
    }
  }
}

async function stopScreenShare() {
  if (!screenShareStream) return;
  const stream = screenShareStream;
  screenShareStream = null;
  const cameraTrack = callMediaStream?.getVideoTracks()[0];
  const videoSender = activeCall?.peerConnection?.getSenders().find((sender) => sender.track?.kind === "video");
  try {
    if (videoSender && cameraTrack) await videoSender.replaceTrack(cameraTrack);
  } catch (error) {
    console.error("Could not restore the camera after screen sharing:", error);
    showToast("Could not restore your camera after screen sharing.");
  }
  stream.getTracks().forEach((track) => track.stop());
  document.querySelector("#callPreviewVideo").srcObject = callMediaStream;
  document.querySelector("#shareScreenButton").textContent = "Share screen";
  document.querySelector("#callPreviewCaption").textContent = "Call connected.";
}

async function toggleScreenShare() {
  if (screenShareStream) {
    await stopScreenShare();
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    showToast("Screen sharing requires a supported browser on localhost or HTTPS.");
    return;
  }
  try {
    screenShareStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const screenTrack = screenShareStream.getVideoTracks()[0];
    const videoSender = activeCall?.peerConnection?.getSenders().find((sender) => sender.track?.kind === "video");
    if (!screenTrack || !videoSender) throw new Error("The video connection is not ready to share your screen.");
    await videoSender.replaceTrack(screenTrack);
    const video = document.querySelector("#callPreviewVideo");
    video.srcObject = screenShareStream;
    await video.play();
    document.querySelector("#shareScreenButton").textContent = "Stop sharing";
    document.querySelector("#callPreviewCaption").textContent = "You are sharing your screen.";
    screenTrack.addEventListener("ended", () => {
      stopScreenShare().catch((error) => {
        console.error("Could not stop screen sharing:", error);
        showToast("Could not stop screen sharing cleanly.");
      });
    }, { once: true });
  } catch (error) {
    if (error.name === "NotAllowedError") return;
    console.error("Could not share the screen:", error);
    showToast(`The screen could not be shared: ${error.message}`);
    if (screenShareStream) await stopScreenShare();
  }
}
function selectChat(id) {
  activeId = id;
  const chat = activeChat();
  if (!chat) return;
  closeNewChatView();
  closeChatOptionsMenu();
  messageSearchQuery = "";
  messageSearchInput.value = "";
  messageSearchBar.hidden = true;
  currentMessageMatch = 0;
  chat.unread = 0;
  renderChatList();
  renderMessages();
  appShell.classList.add("show-chat");
  messageInput.focus({ preventScroll: true });
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2400);
}

async function sendMessage(text, attachment) {
  const cleanText = text.trim();
  if (!cleanText && !attachment) return;
  const chat = activeChat();
  if (!chat) return;
  try {
    await apiRequest(`/api/chats/${chat.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: cleanText, attachment })
    });
    await refreshChats();
  } catch (error) {
    showToast(error.message);
  }
}

function openGroupDialog(type) {
  groupType = type;
  const isCommunity = type === "community";
  document.querySelector("#groupDialogEyebrow").textContent = isCommunity ? "BRING PEOPLE TOGETHER" : "GET TOGETHER";
  document.querySelector("#groupDialogTitle").textContent = isCommunity ? "Create a community" : "Create a group";
  document.querySelector("#groupDialogDescription").textContent = isCommunity
    ? "Create a space for a wider community and choose its first members."
    : "Name your group and choose contacts to add.";
  document.querySelector("#groupName").placeholder = isCommunity ? "Community name" : "Give it a name";
  document.querySelector("#communityDescriptionField").hidden = !isCommunity;
  document.querySelector("#communityDescription").value = "";
  document.querySelector("#groupError").textContent = "";
  const members = chats.filter((chat) => !chat.group && !chat.self);
  document.querySelector("#groupMemberList").innerHTML = members.length ? members.map((chat) => `
    <label class="group-member-option">
      <input type="checkbox" name="groupMember" value="${escapeHtml(chat.id)}" />
      <span class="new-chat-avatar ${escapeHtml(chat.avatar)}">${escapeHtml(chat.initials)}</span>
      <span><strong>${escapeHtml(chat.name)}</strong><small>${escapeHtml(chat.phone || contactUsername(chat))}</small></span>
    </label>
  `).join("") : `<div class="new-chat-empty">Add a contact first, then you can invite them here.</div>`;
  document.querySelector("#selectedMemberCount").textContent = "0 selected";
  document.querySelector("#createGroupSubmit").innerHTML = `${isCommunity ? "Create community" : "Create group"} <span aria-hidden="true">→</span>`;
  document.querySelector("#groupDialog").hidden = false;
  document.querySelector("#groupName").focus();
}

document.querySelector("#groupMemberList").addEventListener("change", () => {
  const count = document.querySelectorAll('#groupMemberList input[name="groupMember"]:checked').length;
  document.querySelector("#selectedMemberCount").textContent = `${count} selected`;
});

document.querySelector("#groupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.querySelector("#groupName").value.trim();
  const selectedIds = [...document.querySelectorAll('#groupMemberList input[name="groupMember"]:checked')].map((input) => input.value);
  const error = document.querySelector("#groupError");
  error.textContent = "";
  if (name.length < 2) {
    error.textContent = "Enter a name with at least 2 characters.";
    return;
  }
  if (selectedIds.length === 0) {
    error.textContent = "Choose at least one contact to continue.";
    return;
  }
  let created;
  try {
    ({ chat: created } = await apiRequest("/api/groups", {
      method: "POST",
      body: JSON.stringify({
        name,
        type: groupType,
        description: document.querySelector("#communityDescription").value.trim(),
        memberIds: selectedIds.map((id) => chats.find((chat) => chat.id === id)?.contactId).filter(Boolean)
      })
    }));
    await refreshChats();
  } catch (requestError) {
    error.textContent = requestError.message;
    return;
  }
  document.querySelector("#groupDialog").hidden = true;
  document.querySelector("#groupForm").reset();
  activeFilter = "all";
  document.querySelectorAll(".filter-chip").forEach((chip) => {
    const selected = chip.dataset.filter === "all";
    chip.classList.toggle("is-active", selected);
    chip.setAttribute("aria-selected", String(selected));
  });
  selectChat(created.id);
  showToast(created.community ? "Community created." : "Group created.");
});

conversationList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-chat-id]");
  if (button) selectChat(button.dataset.chatId);
});

messages.addEventListener("click", (event) => {
  const button = event.target.closest("[data-report-message-id]");
  if (!button) return;
  pendingReportMessageId = button.dataset.reportMessageId;
  document.querySelector("#reportReason").value = "";
  document.querySelector("#reportMessageError").textContent = "";
  document.querySelector("#reportMessageDialog").hidden = false;
  document.querySelector("#reportReason").focus();
});

document.querySelector("#reportMessageForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const chat = activeChat();
  const error = document.querySelector("#reportMessageError");
  const reason = document.querySelector("#reportReason").value.trim();
  error.textContent = "";
  if (!chat || !pendingReportMessageId) {
    error.textContent = "Select a message to report.";
    return;
  }
  try {
    await apiRequest(`/api/chats/${chat.id}/messages/${pendingReportMessageId}/report`, {
      method: "POST",
      body: JSON.stringify({ reason })
    });
    document.querySelector("#reportMessageDialog").hidden = true;
    pendingReportMessageId = null;
    showToast("Report submitted for moderator review.");
  } catch (requestError) {
    error.textContent = requestError.message;
  }
});

document.querySelectorAll(".filter-chip").forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    document.querySelectorAll(".filter-chip").forEach((chip) => {
      const selected = chip === button;
      chip.classList.toggle("is-active", selected);
      chip.setAttribute("aria-selected", String(selected));
    });
    renderChatList();
  });
});

searchInput.addEventListener("input", () => {
  query = searchInput.value.trim();
  renderChatList();
});

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInput.value;
  if (!text.trim()) return;
  messageInput.value = "";
  await sendMessage(text);
  messageInput.focus();
});

document.querySelector("#backButton").addEventListener("click", () => appShell.classList.remove("show-chat"));
document.querySelector("#newChatButton").addEventListener("click", () => {
  openNewChatView();
});
document.querySelector("#newChatBackButton").addEventListener("click", closeNewChatView);
newChatSearchInput.addEventListener("input", () => {
  newChatQuery = newChatSearchInput.value.trim();
  renderNewChatContacts();
});
document.querySelector("#newChatContactList").addEventListener("click", (event) => {
  const contactButton = event.target.closest("[data-new-chat-id]");
  if (contactButton) selectChat(contactButton.dataset.newChatId);
});
document.querySelector("#selfChatButton").addEventListener("click", async () => {
  let selfChat = chats.find((chat) => chat.self);
  if (!selfChat) {
    try {
      ({ chat: selfChat } = await apiRequest("/api/self-chat", { method: "POST" }));
      await refreshChats();
    } catch (error) {
      showToast(error.message);
      return;
    }
  }
  selectChat(selfChat.id);
});
document.querySelector("#newContactButton").addEventListener("click", () => {
  document.querySelector("#contactForm").reset();
  document.querySelector("#contactError").textContent = "";
  document.querySelector("#contactCountryCode").value = profile?.phone.match(/^\+\d+/)?.[0] || "+234";
  document.querySelector("#contactDialog").hidden = false;
  document.querySelector("#contactName").focus();
});
document.querySelector("#newGroupButton").addEventListener("click", () => openGroupDialog("group"));
document.querySelector("#newCommunityButton").addEventListener("click", () => openGroupDialog("community"));
document.querySelector("#inviteButton").addEventListener("click", async () => {
  if (!navigator.contacts?.select) {
    showToast("Contact import is not supported here. Choose New contact to add someone.");
    return;
  }
  try {
    const selected = await navigator.contacts.select(["name", "tel"], { multiple: false });
    const imported = selected[0];
    if (!imported) return;
    const phone = imported.tel?.[0] || "";
    if (!phone) {
      showToast("That contact doesn't have a phone number.");
      return;
    }
    const callingCode = phone.match(/^\s*(\+\d{1,4})/);
    const countryCode = document.querySelector("#contactCountryCode");
    document.querySelector("#contactName").value = imported.name?.[0] || "";
    if (callingCode && [...countryCode.options].some((option) => option.value === callingCode[1])) {
      countryCode.value = callingCode[1];
      document.querySelector("#contactPhone").value = phone.replace(/^\s*\+\d{1,4}/, "").trim();
    } else {
      countryCode.value = "+234";
      document.querySelector("#contactPhone").value = phone.replace(/\D/g, "");
    }
    document.querySelector("#contactDialog").hidden = false;
    document.querySelector("#contactName").focus();
  } catch (error) {
    console.warn("Could not import a contact:", error);
    showToast("Contact import was cancelled or unavailable.");
  }
});
const optionsMenu = document.querySelector("#optionsMenu");
const moreButton = document.querySelector("#moreButton");
function closeOptionsMenu() {
  optionsMenu.hidden = true;
  moreButton.setAttribute("aria-expanded", "false");
}

moreButton.addEventListener("click", () => {
  optionsMenu.hidden = !optionsMenu.hidden;
  moreButton.setAttribute("aria-expanded", String(!optionsMenu.hidden));
});

document.querySelector("#settingsButton").addEventListener("click", () => {
  closeOptionsMenu();
  document.querySelector("#settingsName").value = profile?.name || "";
  document.querySelector("#settingsEmail").value = profile?.email || "";
  document.querySelector("#settingsPhone").value = profile?.phone || "";
  document.querySelector("#settingsError").textContent = "";
  document.querySelector("#settingsDialog").hidden = false;
  document.querySelector("#settingsName").focus();
});

async function signOut() {
  if (!window.confirm("Log out of Chatter on this device?")) return;
  if (activeCall) await endCall();
  if (incomingCall) await declineIncomingCall();
  try {
    await apiRequest("/api/logout", { method: "POST" });
  } catch (error) {
    showToast(error.message);
    return;
  }
  profile = null;
  chats = [];
  activeId = null;
  closeOptionsMenu();
  appShell.hidden = true;
  authScreen.hidden = false;
  registerForm.hidden = false;
  loginForm.hidden = true;
  registerForm.reset();
  document.querySelector("#registerError").textContent = "";
  document.querySelector("#loginError").textContent = "";
  if (chatEvents) chatEvents.close();
  chatEvents = null;
}

document.querySelector("#menuSignOutButton").addEventListener("click", signOut);
document.querySelector("#profileButton").addEventListener("click", () => {
  closeOptionsMenu();
  document.querySelector("#settingsButton").click();
});
document.querySelector("#sortButton").addEventListener("click", () => showToast("Showing your most recent conversations."));
document.querySelector("#callButton").addEventListener("click", () => {
  const chat = activeChat();
  if (!chat) return;
  document.querySelector("#callContactName").textContent = chat.name;
  document.querySelector("#callChoiceError").textContent = "";
  document.querySelector("#callChoiceDialog").hidden = false;
});
document.querySelector("#startAudioCallButton").addEventListener("click", () => startCall("audio"));
document.querySelector("#startVideoCallButton").addEventListener("click", () => startCall("video"));
document.querySelector("#acceptCallButton").addEventListener("click", acceptIncomingCall);
document.querySelector("#declineCallButton").addEventListener("click", declineIncomingCall);
document.querySelector("#toggleMicrophoneButton").addEventListener("click", () => {
  microphoneEnabled = !microphoneEnabled;
  callMediaStream?.getAudioTracks().forEach((track) => { track.enabled = microphoneEnabled; });
  document.querySelector("#toggleMicrophoneButton").textContent = microphoneEnabled ? "Mute mic" : "Unmute mic";
});
document.querySelector("#toggleCameraButton").addEventListener("click", () => {
  cameraEnabled = !cameraEnabled;
  callMediaStream?.getVideoTracks().forEach((track) => { track.enabled = cameraEnabled; });
  document.querySelector("#toggleCameraButton").textContent = cameraEnabled ? "Turn camera off" : "Turn camera on";
});
document.querySelector("#shareScreenButton").addEventListener("click", toggleScreenShare);
document.querySelector("#endCallButton").addEventListener("click", endCall);
document.querySelector("#chatMoreButton").addEventListener("click", () => {
  const menu = document.querySelector("#chatOptionsMenu");
  menu.hidden = !menu.hidden;
  document.querySelector("#chatMoreButton").setAttribute("aria-expanded", String(!menu.hidden));
});
document.querySelector("#viewContactButton").addEventListener("click", openContactDetails);
document.querySelector("#editContactButton").addEventListener("click", () => {
  closeChatOptionsMenu();
  openEditContact();
});
document.querySelector("#editContactFromDetails").addEventListener("click", openEditContact);
document.querySelector("#clearChatButton").addEventListener("click", async () => {
  closeChatOptionsMenu();
  const chat = activeChat();
  if (!chat || !window.confirm(`Clear all messages in "${chat.name}"?`)) return;
  try {
    await apiRequest(`/api/chats/${chat.id}/messages`, { method: "DELETE" });
    await refreshChats();
    showToast("Chat messages cleared.");
  } catch (error) {
    showToast(error.message);
  }
});
document.querySelector("#editChatContactForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const chat = activeChat();
  const name = document.querySelector("#editChatContactName").value.trim();
  const phone = document.querySelector("#editChatContactPhone").value.trim();
  const error = document.querySelector("#editChatContactError");
  error.textContent = "";
  if (!chat || name.length < 2) {
    error.textContent = "Enter a name with at least 2 characters.";
    return;
  }
  const digits = phone.replace(/\D/g, "");
  if (phone && (digits.length < 7 || digits.length > 15)) {
    error.textContent = "Enter a valid phone number with 7 to 15 digits.";
    return;
  }
  if (phone && digits !== chat.phone?.replace(/\D/g, "")) {
    error.textContent = "A contact's phone number is linked to their account and cannot be changed here.";
    return;
  }
  try {
    await apiRequest(`/api/chats/${chat.id}/contact`, {
      method: "PATCH",
      body: JSON.stringify({ name })
    });
    await refreshChats();
    document.querySelector("#editChatContactDialog").hidden = true;
    showToast("Contact name updated.");
  } catch (requestError) {
    error.textContent = requestError.message;
  }
});
document.querySelector("#chatSearchButton").addEventListener("click", () => {
  messageSearchBar.hidden = false;
  messageSearchInput.focus();
});
messageSearchInput.addEventListener("input", () => {
  messageSearchQuery = messageSearchInput.value.trim();
  currentMessageMatch = 0;
  renderMessages();
  if (messageSearchMatches.length) {
    document.querySelector(`[data-message-index="${messageSearchMatches[0]}"]`)?.scrollIntoView({ block: "center" });
  }
});
document.querySelector("#previousMatchButton").addEventListener("click", () => goToMessageMatch(-1));
document.querySelector("#nextMatchButton").addEventListener("click", () => goToMessageMatch(1));
document.querySelector("#closeMessageSearchButton").addEventListener("click", () => {
  messageSearchQuery = "";
  messageSearchInput.value = "";
  currentMessageMatch = 0;
  messageSearchBar.hidden = true;
  renderMessages();
});

document.querySelector("#attachButton").addEventListener("click", () => document.querySelector("#fileInput").click());
document.querySelector("#fileInput").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const size = file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
  showToast("Files are not uploaded to the server yet. Send a text message instead.");
  event.target.value = "";
});

document.querySelector("#emojiButton").addEventListener("click", () => {
  emojiPopover.hidden = !emojiPopover.hidden;
});
emojiPopover.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  messageInput.value += button.textContent;
  messageInput.focus();
  emojiPopover.hidden = true;
});
document.addEventListener("click", (event) => {
  if (!emojiPopover.contains(event.target) && !event.target.closest("#emojiButton")) emojiPopover.hidden = true;
  if (!optionsMenu.contains(event.target) && !moreButton.contains(event.target)) closeOptionsMenu();
  const chatMenu = document.querySelector("#chatOptionsMenu");
  const chatMoreButton = document.querySelector("#chatMoreButton");
  if (!chatMenu.contains(event.target) && !chatMoreButton.contains(event.target)) closeChatOptionsMenu();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput.focus();
  }
  if (event.key === "Escape") {
    emojiPopover.hidden = true;
    closeOptionsMenu();
    closeChatOptionsMenu();
    if (activeCall) {
      endCall();
      return;
    }
    if (incomingCall) {
      declineIncomingCall();
      return;
    }
    document.querySelectorAll(".dialog-backdrop:not(#callSessionDialog):not(#incomingCallDialog)").forEach((dialog) => { dialog.hidden = true; });
  }
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => { button.closest(".dialog-backdrop").hidden = true; });
});
document.querySelectorAll(".dialog-backdrop").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    if (dialog.id === "callSessionDialog") endCall();
    else dialog.hidden = true;
  });
});

document.querySelector("#contactForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.querySelector("#contactName").value.trim();
  const countryCode = document.querySelector("#contactCountryCode").value;
  const digits = document.querySelector("#contactPhone").value.replace(/\D/g, "");
  const error = document.querySelector("#contactError");
  error.textContent = "";
  if (name.length < 2) {
    error.textContent = "Enter a name with at least 2 characters.";
    return;
  }
  if (digits.length < 7 || digits.length > 15) {
    error.textContent = "Enter a valid phone number with 7 to 15 digits.";
    return;
  }
  const phone = `${countryCode} ${digits}`;
  const normalizedPhone = phone.replace(/\D/g, "");
  const existing = chats.find((chat) => chat.phone?.replace(/\D/g, "") === normalizedPhone);
  if (existing) {
    document.querySelector("#contactDialog").hidden = true;
    selectChat(existing.id);
    showToast(`${existing.name} is already in your contacts.`);
    return;
  }
  let contactChat;
  try {
    ({ chat: contactChat } = await apiRequest("/api/contacts", {
      method: "POST",
      body: JSON.stringify({ name, phone })
    }));
    await refreshChats();
  } catch (requestError) {
    error.textContent = requestError.message;
    return;
  }
  document.querySelector("#contactDialog").hidden = true;
  document.querySelector("#searchInput").value = "";
  query = "";
  activeFilter = "all";
  document.querySelectorAll(".filter-chip").forEach((chip) => {
    const selected = chip.dataset.filter === "all";
    chip.classList.toggle("is-active", selected);
    chip.setAttribute("aria-selected", String(selected));
  });
  selectChat(contactChat.id);
  showToast(`${name} added to your contacts.`);
});

document.querySelector("#settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.querySelector("#settingsName").value.trim();
  const email = document.querySelector("#settingsEmail").value.trim().toLowerCase();
  const phoneInput = document.querySelector("#settingsPhone").value.trim();
  const phoneDigits = phoneInput.replace(/\D/g, "");
  const error = document.querySelector("#settingsError");
  error.textContent = "";
  if (name.length < 2) {
    error.textContent = "Enter a name with at least 2 characters.";
    return;
  }
  if (phoneDigits.length < 7 || phoneDigits.length > 15) {
    error.textContent = "Enter a valid phone number with 7 to 15 digits.";
    return;
  }
  const nextProfile = { name, email, phone: phoneInput };
  try {
    const result = await apiRequest("/api/profile", {
      method: "PATCH",
      body: JSON.stringify(nextProfile)
    });
    profile = result.user;
  } catch (requestError) {
    error.textContent = requestError.message;
    return;
  }
  applyProfile();
  document.querySelector("#settingsDialog").hidden = true;
  showToast("Your account details have been updated.");
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.querySelector("#registerName").value.trim();
  const email = document.querySelector("#registerEmail").value.trim().toLowerCase();
  const countryCode = document.querySelector("#countryCode").value;
  const phoneDigits = document.querySelector("#registerPhone").value.replace(/\D/g, "");
  const error = document.querySelector("#registerError");
  error.textContent = "";
  if (name.length < 2) {
    error.textContent = "Please enter a name with at least 2 characters.";
    return;
  }
  if (phoneDigits.length < 7 || phoneDigits.length > 15) {
    error.textContent = "Enter a valid phone number with 7 to 15 digits.";
    return;
  }
  const password = document.querySelector("#registerPassword").value;
  try {
    const result = await apiRequest("/api/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password, phone: `${countryCode}${phoneDigits}` })
    });
    profile = result.user;
    chats = result.chats;
    activeId = chats[0]?.id || null;
    openChatApp();
    subscribeToChatUpdates();
  } catch (requestError) {
    error.textContent = requestError.message;
  }
});

document.querySelector("#showLoginButton").addEventListener("click", () => {
  registerForm.hidden = true;
  loginForm.hidden = false;
  document.querySelector("#loginError").textContent = "";
  document.querySelector("#loginEmail").focus();
});

document.querySelector("#showRegisterButton").addEventListener("click", () => {
  loginForm.hidden = true;
  registerForm.hidden = false;
  document.querySelector("#registerError").textContent = "";
  document.querySelector("#registerName").focus();
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.querySelector("#loginError");
  error.textContent = "";
  try {
    const result = await apiRequest("/api/login", {
      method: "POST",
      body: JSON.stringify({
        email: document.querySelector("#loginEmail").value.trim(),
        password: document.querySelector("#loginPassword").value
      })
    });
    profile = result.user;
    chats = result.chats;
    activeId = chats[0]?.id || null;
    openChatApp();
    subscribeToChatUpdates();
  } catch (requestError) {
    error.textContent = requestError.message;
  }
});

let chatEvents = null;

async function refreshChats() {
  const previousId = activeId;
  const result = await apiRequest("/api/chats");
  chats = result.chats;
  activeId = chats.some((chat) => chat.id === previousId) ? previousId : chats[0]?.id || null;
  renderChatList();
  renderNewChatContacts();
  renderMessages();
}

function subscribeToChatUpdates() {
  chatEvents?.close();
  chatEvents = new EventSource("/api/events");
  chatEvents.addEventListener("message", (event) => {
    try {
      const update = JSON.parse(event.data);
      if (update.type === "call") {
        handleCallEvent(update).catch((error) => {
          console.error("Could not handle a call update:", error);
          showToast(`Call update failed: ${error.message}`);
        });
        return;
      }
      if (update.type !== "chats" || !Array.isArray(update.chats)) return;
      const previousId = activeId;
      chats = update.chats;
      activeId = chats.some((chat) => chat.id === previousId) ? previousId : chats[0]?.id || null;
      renderChatList();
      renderNewChatContacts();
      renderMessages();
    } catch (error) {
      console.error("Could not read a live chat update:", error);
    }
  });
  chatEvents.onerror = () => {
    if (chatEvents?.readyState === EventSource.CLOSED) {
      showToast("Live updates disconnected. Refresh the page to reconnect.");
    }
  };
}

async function startApp() {
  renderChatList();
  renderMessages();
  try {
    const result = await apiRequest("/api/session");
    if (!result.user) {
      profile = null;
      chats = [];
      activeId = null;
      appShell.hidden = true;
      authScreen.hidden = false;
      return;
    }
    profile = result.user;
    chats = result.chats;
    activeId = chats[0]?.id || null;
    openChatApp();
    subscribeToChatUpdates();
  } catch (error) {
    if (!error.message.includes("log in")) {
      showToast(`Could not connect to Chatter: ${error.message}`);
    }
    profile = null;
    appShell.hidden = true;
    authScreen.hidden = false;
  }
}

startApp();
