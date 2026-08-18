requireRole("subadmin");

function setNote(id, message, type) {
  const el = document.getElementById(id);
  el.textContent = message || "";
  el.className = "form-note" + (type ? ` ${type}` : "");
}

function setBalance(amount) {
  document.getElementById("wallet-pill").textContent = `${amount} tokens`;
  document.getElementById("overview-balance").textContent = amount;
}

async function loadMe() {
  const me = await api("/subadmin/me");
  setBalance(me.walletBalance);
}

async function loadDashboardStats() {
  const d = await api("/subadmin/dashboard");
  document.getElementById("stat-user-count").textContent = d.userCount;
  document.getElementById("stat-locked-users").textContent = d.lockedUsers;
  document.getElementById("stat-total-user-balance").textContent = d.totalUserBalance;
  document.getElementById("stat-pending-deposits").textContent = d.pendingDeposits;
  document.getElementById("stat-pending-withdrawals").textContent = d.pendingWithdrawals;
  document.getElementById("stat-deposit-volume").textContent = d.approvedDepositVolume7d;
  document.getElementById("stat-withdrawal-volume").textContent = d.approvedWithdrawalVolume7d;
  document.getElementById("stat-approved-volume").textContent = d.approvedDepositVolume7d + d.approvedWithdrawalVolume7d;
  document.getElementById("stat-unread-support").textContent = d.unreadSupportThreads;
}

async function loadDeposits() {
  const rows = await api("/subadmin/deposits");
  const body = document.getElementById("deposits-body");
  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="5">No deposit requests yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${r.amount}</td>
      <td>${escapeHtml(r.note || "—")}</td>
      <td><span class="badge ${r.status}">${r.status}</span></td>
      <td>${formatDate(r.createdAt)}</td>
      <td>${formatDate(r.reviewedAt)}</td>
    </tr>`
    )
    .join("");
}

async function loadPaymentRequests() {
  const rows = await api("/subadmin/payment-requests");
  const body = document.getElementById("payments-body");
  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="5">No payment detail requests yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.method)}</td>
      <td>${escapeHtml(r.details)}</td>
      <td><span class="badge ${r.status}">${r.status}</span></td>
      <td>${formatDate(r.createdAt)}</td>
      <td>${formatDate(r.reviewedAt)}</td>
    </tr>`
    )
    .join("");
}

document.getElementById("deposit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const amount = Number(document.getElementById("deposit-amount").value);
  const note = document.getElementById("deposit-note").value.trim();
  setNote("deposit-note-msg", "", "");
  try {
    await api("/subadmin/deposits", { method: "POST", body: { amount, note } });
    document.getElementById("deposit-form").reset();
    setNote("deposit-note-msg", "Deposit request submitted for approval.", "success");
    loadDeposits();
  } catch (err) {
    setNote("deposit-note-msg", err.message, "error");
  }
});

document.getElementById("payment-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const method = document.getElementById("payment-method").value.trim();
  const details = document.getElementById("payment-details").value.trim();
  setNote("payment-note-msg", "", "");
  try {
    await api("/subadmin/payment-requests", { method: "POST", body: { method, details } });
    document.getElementById("payment-form").reset();
    setNote("payment-note-msg", "Payment details submitted for approval.", "success");
    loadPaymentRequests();
  } catch (err) {
    setNote("payment-note-msg", err.message, "error");
  }
});

// ---- Users ----
let usersCache = [];
let passwordModalTargetId = null;
let usersSearchDebounce = null;

async function loadUsers() {
  const search = document.getElementById("users-search-input").value.trim();
  const status = document.getElementById("users-status-filter").value;
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (status) params.set("status", status);

  usersCache = await api(`/subadmin/users?${params.toString()}`);
  const body = document.getElementById("users-body");
  if (usersCache.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="8">No users match.</td></tr>`;
    return;
  }
  body.innerHTML = usersCache
    .map(
      (u) => `
    <tr>
      <td>${escapeHtml(u.name)}</td>
      <td>+91 ${escapeHtml(u.phone)}</td>
      <td>${u.email ? escapeHtml(u.email) : `<span class="hint">Not added</span>`}</td>
      <td>${u.email ? `<span class="badge ${u.emailVerified ? "active" : "pending"}">${u.emailVerified ? "Verified" : "Unverified"}</span>` : "—"}</td>
      <td><span class="badge ${u.status}">${u.status}</span></td>
      <td>${u.walletBalance}</td>
      <td>${formatDate(u.createdAt)}</td>
      <td class="actions">
        <button class="inline-btn ghost" data-action="view-user" data-id="${u.id}">View</button>
      </td>
    </tr>`
    )
    .join("");
}

document.getElementById("users-search-input").addEventListener("input", () => {
  clearTimeout(usersSearchDebounce);
  usersSearchDebounce = setTimeout(loadUsers, 300);
});
document.getElementById("users-status-filter").addEventListener("change", loadUsers);

document.getElementById("users-body").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action=view-user]");
  if (!btn) return;
  openUserDetail(btn.dataset.id);
});

document.getElementById("modal-cancel").addEventListener("click", () => {
  document.getElementById("password-modal").classList.add("hidden");
});

document.getElementById("modal-confirm").addEventListener("click", async () => {
  const password = document.getElementById("modal-password").value;
  setNote("modal-note", "", "");
  try {
    await api(`/subadmin/users/${passwordModalTargetId}/password`, { method: "POST", body: { password } });
    document.getElementById("password-modal").classList.add("hidden");
  } catch (err) {
    setNote("modal-note", err.message, "error");
  }
});

// ---- User detail modal (history + lock/unlock) ----
let userDetailCache = null;
let userDetailSubtab = "deposits";

function subadminModalTable(headers, rows, emptyMsg) {
  if (!rows.length) return `<p class="hint">${emptyMsg}</p>`;
  return `<div class="table-wrap"><table class="dash-table"><thead><tr>${headers
    .map((h) => `<th>${h}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

async function openUserDetail(id) {
  userDetailCache = await api(`/subadmin/users/${id}`);
  userDetailSubtab = "deposits";
  renderUserDetail();
  document.getElementById("user-detail-modal").classList.remove("hidden");
}

function renderUserDetail() {
  const u = userDetailCache;
  document.getElementById("user-detail-name").textContent = `${u.name} — +91 ${u.phone}`;
  document.getElementById("user-detail-stats").innerHTML = `
    <div class="dash-card"><h3>Status</h3><p class="hint"><span class="badge ${u.status}">${u.status}</span></p></div>
    <div class="dash-card"><h3>Wallet Balance</h3><div class="stat">${u.walletBalance}</div></div>
    <div class="dash-card"><h3>Joined</h3><p class="hint">${formatDate(u.createdAt)}</p></div>
  `;

  const tabs = [
    { key: "deposits", label: "Deposits" },
    { key: "withdrawals", label: "Withdrawals" },
  ];
  document.getElementById("user-detail-subtabs").innerHTML = tabs
    .map((t) => `<button class="games-admin-subtab${userDetailSubtab === t.key ? " active" : ""}" data-user-subtab="${t.key}">${t.label}</button>`)
    .join("");
  document.querySelectorAll("[data-user-subtab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      userDetailSubtab = btn.dataset.userSubtab;
      renderUserDetail();
    });
  });

  const content = document.getElementById("user-detail-content");
  if (userDetailSubtab === "deposits") {
    content.innerHTML = subadminModalTable(
      ["Amount", "Note", "Status", "Requested", "Reviewed"],
      u.deposits.map((d) => [d.amount, escapeHtml(d.note || "—"), `<span class="badge ${d.status === "approved" ? "active" : d.status === "rejected" ? "locked" : "pending"}">${d.status}</span>`, formatDate(d.createdAt), d.reviewedAt ? formatDate(d.reviewedAt) : "—"]),
      "No deposit requests."
    );
  } else {
    content.innerHTML = subadminModalTable(
      ["Amount", "Send To", "Status", "Requested", "Reviewed"],
      u.withdrawals.map((w) => [w.amount, escapeHtml(w.payoutDetails), `<span class="badge ${w.status === "approved" ? "active" : w.status === "rejected" ? "locked" : "pending"}">${w.status}</span>`, formatDate(w.createdAt), w.reviewedAt ? formatDate(w.reviewedAt) : "—"]),
      "No withdrawal requests."
    );
  }

  const lockBtn = document.getElementById("user-detail-toggle-lock");
  lockBtn.textContent = u.status === "locked" ? "Unlock User" : "Lock User";
  lockBtn.className = u.status === "locked" ? "inline-btn" : "inline-btn danger";
  lockBtn.onclick = async () => {
    const endpoint = u.status === "locked" ? "unlock" : "lock";
    const reason = prompt(`Reason for ${endpoint === "lock" ? "locking" : "unlocking"} this user (optional):`) || null;
    await api(`/subadmin/users/${u.id}/${endpoint}`, { method: "POST", body: { reason } });
    userDetailCache = await api(`/subadmin/users/${u.id}`);
    renderUserDetail();
    loadUsers();
  };
}

document.getElementById("user-detail-close").addEventListener("click", () => {
  document.getElementById("user-detail-modal").classList.add("hidden");
});

document.getElementById("user-detail-password").addEventListener("click", () => {
  passwordModalTargetId = userDetailCache.id;
  document.getElementById("modal-password").value = "";
  setNote("modal-note", "", "");
  document.getElementById("password-modal").classList.remove("hidden");
});

// ---- User deposits ----
async function loadUserDeposits() {
  const status = document.getElementById("user-deposits-status-filter").value;
  const search = document.getElementById("user-deposits-search-input").value.trim().toLowerCase();
  const params = new URLSearchParams();
  if (status) params.set("status", status);

  let rows = await api(`/subadmin/user-deposits?${params.toString()}`);
  if (search) {
    rows = rows.filter((r) => r.userName.toLowerCase().includes(search) || r.userPhone.includes(search));
  }
  const body = document.getElementById("user-deposits-body");
  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">No deposit requests match.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.userName)}<br><span style="color:var(--muted); font-size:0.78rem;">+91 ${escapeHtml(r.userPhone)}</span></td>
      <td>${r.amount}</td>
      <td>${escapeHtml(r.paymentMethod || "—")}</td>
      <td>${escapeHtml(r.transactionReference || "—")}</td>
      <td>${r.hasScreenshot ? `<button type="button" class="view-screenshot-btn" data-deposit-screenshot="${r.id}">View</button>` : "—"}</td>
      <td><span class="badge ${r.status}">${r.status}</span></td>
      <td>${formatDate(r.createdAt)}</td>
      <td class="actions">
        ${
          r.status === "pending"
            ? `<button class="inline-btn" data-action="approve-deposit" data-id="${r.id}">Approve</button>
               <button class="inline-btn danger" data-action="reject-deposit" data-id="${r.id}">Reject</button>`
            : "—"
        }
      </td>
    </tr>`
    )
    .join("");

  body.querySelectorAll("[data-deposit-screenshot]").forEach((btn) => {
    btn.addEventListener("click", () => openImageLightbox(`/subadmin/user-deposits/${btn.dataset.depositScreenshot}/screenshot`));
  });
}

document.getElementById("user-deposits-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === "approve-deposit") {
    await api(`/subadmin/user-deposits/${id}/approve`, { method: "POST" });
  } else if (action === "reject-deposit") {
    await api(`/subadmin/user-deposits/${id}/reject`, { method: "POST" });
  }
  await Promise.all([loadUserDeposits(), loadUsers()]);
});

let userDepositsSearchDebounce = null;
document.getElementById("user-deposits-search-input").addEventListener("input", () => {
  clearTimeout(userDepositsSearchDebounce);
  userDepositsSearchDebounce = setTimeout(loadUserDeposits, 300);
});
document.getElementById("user-deposits-status-filter").addEventListener("change", loadUserDeposits);

// ---- User withdrawals ----
async function loadUserWithdrawals() {
  const status = document.getElementById("user-withdrawals-status-filter").value;
  const search = document.getElementById("user-withdrawals-search-input").value.trim().toLowerCase();
  const params = new URLSearchParams();
  if (status) params.set("status", status);

  let rows = await api(`/subadmin/user-withdrawals?${params.toString()}`);
  if (search) {
    rows = rows.filter((r) => r.userName.toLowerCase().includes(search) || r.userPhone.includes(search));
  }
  const body = document.getElementById("user-withdrawals-body");
  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">No withdrawal requests match.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.userName)}<br><span style="color:var(--muted); font-size:0.78rem;">+91 ${escapeHtml(r.userPhone)}</span></td>
      <td>${r.amount}</td>
      <td>${escapeHtml(r.payoutDetails)}</td>
      <td><span class="badge ${r.status}">${r.status}</span></td>
      <td>${formatDate(r.createdAt)}</td>
      <td class="actions">
        ${
          r.status === "pending"
            ? `<button class="inline-btn" data-action="approve-withdrawal" data-id="${r.id}">Approve</button>
               <button class="inline-btn danger" data-action="reject-withdrawal" data-id="${r.id}">Reject</button>`
            : "—"
        }
      </td>
    </tr>`
    )
    .join("");
}

document.getElementById("user-withdrawals-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === "approve-withdrawal") {
    await api(`/subadmin/user-withdrawals/${id}/approve`, { method: "POST" });
  } else if (action === "reject-withdrawal") {
    await api(`/subadmin/user-withdrawals/${id}/reject`, { method: "POST" });
  }
  await Promise.all([loadUserWithdrawals(), loadUsers()]);
});

let userWithdrawalsSearchDebounce = null;
document.getElementById("user-withdrawals-search-input").addEventListener("input", () => {
  clearTimeout(userWithdrawalsSearchDebounce);
  userWithdrawalsSearchDebounce = setTimeout(loadUserWithdrawals, 300);
});
document.getElementById("user-withdrawals-status-filter").addEventListener("change", loadUserWithdrawals);

// ---- Support ----
let activeThreadUserId = null;

async function loadThreads() {
  const rows = await api("/subadmin/support/threads");
  const list = document.getElementById("thread-list");
  if (rows.length === 0) {
    list.innerHTML = `<p class="hint">No users yet.</p>`;
    return;
  }
  list.innerHTML = rows
    .map(
      (t) => `
    <div class="thread-item ${String(t.userId) === String(activeThreadUserId) ? "active" : ""}" data-id="${t.userId}">
      <div>
        <div class="name">${escapeHtml(t.name)}</div>
        <div class="phone">+91 ${escapeHtml(t.phone)}</div>
      </div>
      <div class="count">${t.messageCount} msg${t.messageCount === 1 ? "" : "s"}</div>
    </div>`
    )
    .join("");
}

async function openThread(userId) {
  activeThreadUserId = userId;
  await loadThreads();

  const chatInput = document.getElementById("chat-input");
  const chatBtn = document.querySelector("#chat-form button[type=submit]");
  const attachBtn = document.getElementById("chat-attach-btn");
  chatInput.disabled = false;
  chatBtn.disabled = false;
  attachBtn.disabled = false;

  const rows = await api(`/subadmin/support/${userId}`);
  const box = document.getElementById("chat-messages");
  if (rows.length === 0) {
    box.innerHTML = `<p class="chat-empty">No messages yet.</p>`;
    return;
  }
  box.innerHTML = rows
    .map(
      (m) => `
    <div class="chat-bubble ${m.senderRole === "subadmin" ? "mine" : "theirs"}">
      ${escapeHtml(m.message)}
      ${m.hasAttachment ? `<button type="button" class="chat-attachment" data-attachment-id="${m.id}">📎 View attachment</button>` : ""}
      <span class="meta">${m.senderRole === "subadmin" ? "You" : "User"} · ${formatDate(m.createdAt)}</span>
    </div>`
    )
    .join("");
  box.scrollTop = box.scrollHeight;
  box.querySelectorAll("[data-attachment-id]").forEach((btn) => {
    btn.addEventListener("click", () => openImageLightbox(`/subadmin/support/${activeThreadUserId}/${btn.dataset.attachmentId}/attachment`));
  });
}

document.getElementById("thread-list").addEventListener("click", (e) => {
  const item = e.target.closest(".thread-item");
  if (!item) return;
  openThread(item.dataset.id);
});

// ---- Chat attachment picker (mirrors the user dashboard's) ----
let chatAttachmentFile = null;

function renderChatAttachPreview() {
  const preview = document.getElementById("chat-attach-preview");
  const btn = document.getElementById("chat-attach-btn");
  if (!chatAttachmentFile) {
    preview.innerHTML = "";
    btn.classList.remove("active");
    return;
  }
  btn.classList.add("active");
  const url = URL.createObjectURL(chatAttachmentFile);
  preview.innerHTML = `
    <span class="attach-chip">
      <img src="${url}" alt="Attachment preview">
      ${escapeHtml(chatAttachmentFile.name)}
      <button type="button" id="chat-attach-remove">Remove</button>
    </span>`;
  document.getElementById("chat-attach-remove").addEventListener("click", () => {
    URL.revokeObjectURL(url);
    setChatAttachment(null);
  });
}

function setChatAttachment(file) {
  if (file) {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      alert("Invalid image format. Upload a JPG, PNG or WebP image.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      alert(`Image exceeds the maximum allowed size of ${MAX_IMAGE_BYTES / (1024 * 1024)}MB.`);
      return;
    }
  }
  chatAttachmentFile = file;
  renderChatAttachPreview();
}

document.getElementById("chat-attach-btn").addEventListener("click", () => {
  document.getElementById("chat-attachment-input").click();
});
document.getElementById("chat-attachment-input").addEventListener("change", (e) => {
  setChatAttachment(e.target.files[0] || null);
});

document.getElementById("chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeThreadUserId) return;
  const input = document.getElementById("chat-input");
  const message = input.value.trim();
  if (!message) return;
  try {
    const formData = new FormData();
    formData.set("message", message);
    if (chatAttachmentFile) formData.set("attachment", chatAttachmentFile);
    await apiUpload(`/subadmin/support/${activeThreadUserId}`, formData);
    input.value = "";
    setChatAttachment(null);
    document.getElementById("chat-attachment-input").value = "";
    openThread(activeThreadUserId);
  } catch (err) {
    alert(err.message);
  }
});

function refreshAll() {
  return Promise.all([
    loadMe(),
    loadDashboardStats(),
    loadDeposits(),
    loadPaymentRequests(),
    loadUsers(),
    loadUserDeposits(),
    loadUserWithdrawals(),
    loadThreads(),
  ]);
}

refreshAll();
initEmailCard("email-card");

// See admin-dashboard.js for why this refreshes everything on any panel
// switch rather than routing per-panel.
document.addEventListener("dash:panelshown", () => refreshAll());
