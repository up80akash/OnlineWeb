requireRole("admin");

const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;
let subadminsCache = [];
let passwordModalTargetId = null;

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
  const me = await api("/admin/me");
  setBalance(me.walletBalance);
}

async function loadSubadmins() {
  subadminsCache = await api("/admin/subadmins");
  renderSubadmins();
  renderTransferOptions();
}

function renderSubadmins() {
  const body = document.getElementById("subadmins-body");
  if (subadminsCache.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">No sub-admins yet. Create one above.</td></tr>`;
    return;
  }

  body.innerHTML = subadminsCache
    .map(
      (s) => `
    <tr>
      <td>${escapeHtml(s.name)}</td>
      <td>+91 ${escapeHtml(s.phone)}</td>
      <td><span class="badge ${s.status}">${s.status}</span></td>
      <td>${s.walletBalance}</td>
      <td>${formatDate(s.createdAt)}</td>
      <td class="actions">
        <button class="inline-btn ghost" data-action="toggle-lock" data-id="${s.id}" data-status="${s.status}">
          ${s.status === "locked" ? "Unlock" : "Lock"}
        </button>
        <button class="inline-btn ghost" data-action="change-password" data-id="${s.id}">Password</button>
        <button class="inline-btn danger" data-action="delete" data-id="${s.id}">Delete</button>
      </td>
    </tr>`
    )
    .join("");
}

function renderTransferOptions() {
  const select = document.getElementById("transfer-subadmin");
  const active = subadminsCache.filter((s) => s.status === "active");
  select.innerHTML = active.length
    ? active.map((s) => `<option value="${s.id}">${escapeHtml(s.name)} (+91 ${escapeHtml(s.phone)})</option>`).join("")
    : `<option value="">No active sub-admins</option>`;

  // Same active sub-admin list, reused as the filter options for Users /
  // User Deposits and as the target list for the user-transfer modal.
  const filterOptionsHtml = subadminsCache
    .map((s) => `<option value="${s.id}">${escapeHtml(s.name)}${s.isDefault ? " (default)" : ""}</option>`)
    .join("");
  ["users-subadmin-filter", "admin-user-deposits-subadmin-filter"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const current = el.value;
    el.innerHTML = `<option value="">All Sub-Admins</option>${filterOptionsHtml}`;
    el.value = current;
  });
  const transferTarget = document.getElementById("transfer-user-subadmin");
  if (transferTarget) {
    transferTarget.innerHTML = active.length
      ? active.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}${s.isDefault ? " (default)" : ""}</option>`).join("")
      : `<option value="">No active sub-admins</option>`;
  }
}

async function loadTransactions() {
  const rows = await api("/admin/transactions");
  const body = document.getElementById("transactions-body");
  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="5">No activity yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${r.type.replace("_", " ")}</td>
      <td>${escapeHtml(r.fromName || "—")}</td>
      <td>${escapeHtml(r.toName || "—")}</td>
      <td>${r.amount}</td>
      <td>${formatDate(r.createdAt)}</td>
    </tr>`
    )
    .join("");
}

async function loadDeposits() {
  const rows = await api("/admin/deposits");
  const body = document.getElementById("deposits-body");
  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">No deposit requests yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.subadminName)}<br><span style="color:var(--muted); font-size:0.78rem;">+91 ${escapeHtml(r.subadminPhone)}</span></td>
      <td>${r.amount}</td>
      <td>${escapeHtml(r.note || "—")}</td>
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
}

async function loadPaymentRequests() {
  const rows = await api("/admin/payment-requests");
  const body = document.getElementById("payments-body");
  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">No payment detail requests yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.subadminName)}<br><span style="color:var(--muted); font-size:0.78rem;">+91 ${escapeHtml(r.subadminPhone)}</span></td>
      <td>${escapeHtml(r.method)}</td>
      <td>${escapeHtml(r.details)}</td>
      <td><span class="badge ${r.status}">${r.status}</span></td>
      <td>${formatDate(r.createdAt)}</td>
      <td class="actions">
        ${
          r.status === "pending"
            ? `<button class="inline-btn" data-action="approve-payment" data-id="${r.id}">Approve</button>
               <button class="inline-btn danger" data-action="reject-payment" data-id="${r.id}">Reject</button>`
            : "—"
        }
      </td>
    </tr>`
    )
    .join("");
}

// ---- Deposit instructions (shown to users before they deposit) ----
async function loadDepositInstructions() {
  const info = await api("/admin/deposit-instructions");
  document.getElementById("di-min-amount").value = info.minAmount;
  document.getElementById("di-max-amount").value = info.maxAmount;
  document.getElementById("di-instructions").value = info.instructions;
}

document.getElementById("deposit-instructions-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const minAmount = Number(document.getElementById("di-min-amount").value);
  const maxAmount = Number(document.getElementById("di-max-amount").value);
  const instructions = document.getElementById("di-instructions").value.trim();
  setNote("deposit-instructions-note", "", "");
  try {
    await api("/admin/deposit-instructions", { method: "PUT", body: { minAmount, maxAmount, instructions } });
    setNote("deposit-instructions-note", "Deposit instructions saved.", "success");
  } catch (err) {
    setNote("deposit-instructions-note", err.message, "error");
  }
});

// ---- User deposits (platform-wide) ----
async function loadAdminUserDeposits() {
  const status = document.getElementById("admin-user-deposits-status-filter").value;
  const subAdminId = document.getElementById("admin-user-deposits-subadmin-filter").value;
  const search = document.getElementById("admin-user-deposits-search-input").value.trim().toLowerCase();
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (subAdminId) params.set("subAdminId", subAdminId);

  let rows = await api(`/admin/user-deposits?${params.toString()}`);
  if (search) {
    rows = rows.filter((r) => r.userName.toLowerCase().includes(search) || r.userPhone.includes(search));
  }
  const body = document.getElementById("admin-user-deposits-body");
  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="9">No deposit requests match.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.userName)}<br><span style="color:var(--muted); font-size:0.78rem;">+91 ${escapeHtml(r.userPhone)}</span></td>
      <td>${escapeHtml(r.subAdminName || "—")}</td>
      <td>${r.amount}</td>
      <td>${escapeHtml(r.paymentMethod || "—")}</td>
      <td>${escapeHtml(r.transactionReference || "—")}</td>
      <td>${r.hasScreenshot ? `<button type="button" class="view-screenshot-btn" data-deposit-screenshot="${r.id}">View</button>` : "—"}</td>
      <td><span class="badge ${r.status}">${r.status}</span></td>
      <td>${formatDate(r.createdAt)}</td>
      <td class="actions">
        ${
          r.status === "pending"
            ? `<button class="inline-btn" data-action="approve-user-deposit" data-id="${r.id}">Approve</button>
               <button class="inline-btn danger" data-action="reject-user-deposit" data-id="${r.id}">Reject</button>`
            : "—"
        }
      </td>
    </tr>`
    )
    .join("");

  body.querySelectorAll("[data-deposit-screenshot]").forEach((btn) => {
    btn.addEventListener("click", () => openImageLightbox(`/admin/user-deposits/${btn.dataset.depositScreenshot}/screenshot`));
  });
}

document.getElementById("admin-user-deposits-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === "approve-user-deposit") {
    await api(`/admin/user-deposits/${id}/approve`, { method: "POST" });
  } else if (action === "reject-user-deposit") {
    await api(`/admin/user-deposits/${id}/reject`, { method: "POST" });
  }
  await Promise.all([loadAdminUserDeposits(), loadSubadmins()]);
});

let adminUserDepositsDebounce = null;
document.getElementById("admin-user-deposits-search-input").addEventListener("input", () => {
  clearTimeout(adminUserDepositsDebounce);
  adminUserDepositsDebounce = setTimeout(loadAdminUserDeposits, 300);
});
document.getElementById("admin-user-deposits-status-filter").addEventListener("change", loadAdminUserDeposits);
document.getElementById("admin-user-deposits-subadmin-filter").addEventListener("change", loadAdminUserDeposits);

// ---- Transfer user to another sub-admin ----
let transferUserTarget = null;

function openTransferUserModal(user) {
  transferUserTarget = user;
  document.getElementById("transfer-user-current").textContent =
    `${user.name} — currently with ${user.subAdminName || "no sub-admin"}`;
  setNote("transfer-user-note", "", "");
  document.getElementById("transfer-user-modal").classList.remove("hidden");
}
window.openTransferUserModal = openTransferUserModal;

document.getElementById("transfer-user-cancel").addEventListener("click", () => {
  document.getElementById("transfer-user-modal").classList.add("hidden");
});

document.getElementById("transfer-user-confirm").addEventListener("click", async () => {
  const subAdminId = Number(document.getElementById("transfer-user-subadmin").value);
  setNote("transfer-user-note", "", "");
  if (!subAdminId) {
    setNote("transfer-user-note", "Select a sub-admin to transfer to.", "error");
    return;
  }
  try {
    await api(`/admin/users/${transferUserTarget.id}/transfer`, { method: "POST", body: { subAdminId } });
    document.getElementById("transfer-user-modal").classList.add("hidden");
    setNote("transfer-user-note", "", "");
    if (window.loadAllUsers) window.loadAllUsers();
    if (window.refreshUserDetailAfterTransfer) window.refreshUserDetailAfterTransfer();
  } catch (err) {
    setNote("transfer-user-note", err.message, "error");
  }
});

async function refreshAll() {
  await Promise.all([loadMe(), loadSubadmins(), loadTransactions(), loadDeposits(), loadPaymentRequests(), loadDepositInstructions()]);
  if (window.initGamesAdminPanel) window.initGamesAdminPanel();
  if (window.initAdminUsersPanel) window.initAdminUsersPanel();
  loadAdminUserDeposits();
}

document.getElementById("mint-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const amount = Number(document.getElementById("mint-amount").value);
  setNote("mint-note", "", "");
  try {
    const result = await api("/admin/wallet/mint", { method: "POST", body: { amount } });
    setBalance(result.walletBalance);
    document.getElementById("mint-form").reset();
    setNote("mint-note", `Added ${amount} tokens to your wallet.`, "success");
    loadTransactions();
  } catch (err) {
    setNote("mint-note", err.message, "error");
  }
});

document.getElementById("transfer-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const subadminId = Number(document.getElementById("transfer-subadmin").value);
  const amount = Number(document.getElementById("transfer-amount").value);
  setNote("transfer-note", "", "");
  if (!subadminId) {
    setNote("transfer-note", "No active sub-admin selected.", "error");
    return;
  }
  try {
    await api("/admin/wallet/transfer", { method: "POST", body: { subadminId, amount } });
    document.getElementById("transfer-form").reset();
    setNote("transfer-note", `Transferred ${amount} tokens.`, "success");
    await Promise.all([loadMe(), loadSubadmins(), loadTransactions()]);
  } catch (err) {
    setNote("transfer-note", err.message, "error");
  }
});

document.getElementById("create-subadmin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("new-name").value.trim();
  const phone = document.getElementById("new-phone").value.trim();
  const password = document.getElementById("new-password").value;
  setNote("create-subadmin-note", "", "");

  if (!INDIAN_MOBILE_REGEX.test(phone)) {
    setNote("create-subadmin-note", "Enter a valid 10-digit mobile number.", "error");
    return;
  }

  try {
    await api("/admin/subadmins", { method: "POST", body: { name, phone, password } });
    document.getElementById("create-subadmin-form").reset();
    setNote("create-subadmin-note", "Sub-admin created.", "success");
    loadSubadmins();
  } catch (err) {
    setNote("create-subadmin-note", err.message, "error");
  }
});

document.getElementById("subadmins-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id, status } = btn.dataset;

  if (action === "toggle-lock") {
    const endpoint = status === "locked" ? "unlock" : "lock";
    await api(`/admin/subadmins/${id}/${endpoint}`, { method: "POST" });
    loadSubadmins();
  } else if (action === "delete") {
    const subadmin = subadminsCache.find((s) => String(s.id) === id);
    if (!confirm(`Delete sub-admin "${subadmin?.name}"? This cannot be undone.`)) return;
    await api(`/admin/subadmins/${id}`, { method: "DELETE" });
    loadSubadmins();
  } else if (action === "change-password") {
    passwordModalTargetId = id;
    document.getElementById("modal-password").value = "";
    setNote("modal-note", "", "");
    document.getElementById("password-modal").classList.remove("hidden");
  }
});

document.getElementById("modal-cancel").addEventListener("click", () => {
  document.getElementById("password-modal").classList.add("hidden");
});

document.getElementById("modal-confirm").addEventListener("click", async () => {
  const password = document.getElementById("modal-password").value;
  setNote("modal-note", "", "");
  try {
    await api(`/admin/subadmins/${passwordModalTargetId}/password`, { method: "POST", body: { password } });
    document.getElementById("password-modal").classList.add("hidden");
  } catch (err) {
    setNote("modal-note", err.message, "error");
  }
});

document.getElementById("deposits-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === "approve-deposit") {
    await api(`/admin/deposits/${id}/approve`, { method: "POST" });
  } else if (action === "reject-deposit") {
    await api(`/admin/deposits/${id}/reject`, { method: "POST" });
  }
  await Promise.all([loadDeposits(), loadSubadmins(), loadTransactions()]);
});

document.getElementById("payments-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === "approve-payment") {
    await api(`/admin/payment-requests/${id}/approve`, { method: "POST" });
  } else if (action === "reject-payment") {
    await api(`/admin/payment-requests/${id}/reject`, { method: "POST" });
  }
  loadPaymentRequests();
});

refreshAll();
initEmailCard("email-card");

// The per-panel "↻ Refresh" buttons (auto-injected by dashboard-common.js)
// and tab clicks both dispatch this -- re-fetching everything on any panel
// switch is simple and cheap enough here (a handful of small queries), and
// keeps every panel's data current without per-panel plumbing.
document.addEventListener("dash:panelshown", () => refreshAll());
