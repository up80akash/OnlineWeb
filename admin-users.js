// Admin "Users" panel: platform-wide user directory (search/filter across
// every sub-admin's users), a detail drill-down (wallet ledger, deposit/
// withdrawal history, recent game bets, past adjustments/status changes),
// direct lock/unlock, and an audited manual balance adjustment. Also drives
// the Sub-Admins panel's "Performance" table.

let adminUsersDebounce = null;
let adminUserDetailCache = null;
let adminUserDetailSubtab = "deposits";

function adminUsersTable(headers, rows, emptyMsg) {
  if (!rows.length) return `<p class="hint">${emptyMsg}</p>`;
  return `<div class="table-wrap"><table class="dash-table"><thead><tr>${headers
    .map((h) => `<th>${h}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

let allUsersCache = [];

async function loadAllUsers() {
  const search = document.getElementById("users-search-input").value.trim();
  const status = document.getElementById("users-status-filter").value;
  const subAdminId = document.getElementById("users-subadmin-filter")?.value;
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (status) params.set("status", status);
  if (subAdminId) params.set("subAdminId", subAdminId);

  allUsersCache = await api(`/admin/users?${params.toString()}`);
  const body = document.getElementById("all-users-body");
  if (allUsersCache.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="9">No users match.</td></tr>`;
    return;
  }
  body.innerHTML = allUsersCache
    .map(
      (u) => `
    <tr>
      <td>${escapeHtml(u.name)}</td>
      <td>+91 ${escapeHtml(u.phone)}</td>
      <td>${u.email ? escapeHtml(u.email) : `<span class="hint">Not added</span>`}</td>
      <td>${u.email ? `<span class="badge ${u.emailVerified ? "active" : "pending"}">${u.emailVerified ? "Verified" : "Unverified"}</span>` : "—"}</td>
      <td><span class="badge ${u.status}">${u.status}</span></td>
      <td>${u.walletBalance}</td>
      <td>${escapeHtml(u.subAdminName || "—")}</td>
      <td>${formatDate(u.createdAt)}</td>
      <td class="actions">
        <button class="inline-btn ghost" data-view-user="${u.id}">View</button>
        <button class="inline-btn ghost" data-transfer-user="${u.id}">Transfer</button>
      </td>
    </tr>`
    )
    .join("");

  body.querySelectorAll("[data-view-user]").forEach((btn) => {
    btn.addEventListener("click", () => openUserDetail(btn.dataset.viewUser));
  });
  body.querySelectorAll("[data-transfer-user]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const user = allUsersCache.find((u) => String(u.id) === btn.dataset.transferUser);
      if (user && window.openTransferUserModal) window.openTransferUserModal(user);
    });
  });
}
window.loadAllUsers = loadAllUsers;

document.getElementById("users-search-input")?.addEventListener("input", () => {
  clearTimeout(adminUsersDebounce);
  adminUsersDebounce = setTimeout(loadAllUsers, 300);
});
document.getElementById("users-status-filter")?.addEventListener("change", loadAllUsers);
document.getElementById("users-subadmin-filter")?.addEventListener("change", loadAllUsers);

async function openUserDetail(id) {
  adminUserDetailCache = await api(`/admin/users/${id}`);
  adminUserDetailSubtab = "deposits";
  renderUserDetailModal();
  document.getElementById("user-detail-modal").classList.remove("hidden");
}

function renderUserDetailModal() {
  const u = adminUserDetailCache;
  document.getElementById("user-detail-name").textContent = `${u.name} — +91 ${u.phone}`;
  document.getElementById("user-detail-stats").innerHTML = `
    <div class="dash-card"><h3>Status</h3><p class="hint"><span class="badge ${u.status}">${u.status}</span></p></div>
    <div class="dash-card"><h3>Wallet Balance</h3><div class="stat">${u.walletBalance}</div></div>
    <div class="dash-card"><h3>Sub-Admin</h3><p class="hint">${u.subAdminName ? escapeHtml(u.subAdminName) + " (+91 " + escapeHtml(u.subAdminPhone || "") + ")" : "—"}</p></div>
    <div class="dash-card"><h3>Joined</h3><p class="hint">${formatDate(u.createdAt)}</p></div>
  `;

  const tabs = [
    { key: "deposits", label: "Deposits" },
    { key: "withdrawals", label: "Withdrawals" },
    { key: "wallet-ledger", label: "Game Wallet Ledger" },
    { key: "bets", label: "Recent Bets" },
    { key: "adjustments", label: "Adjustments" },
    { key: "status-changes", label: "Status History" },
  ];
  document.getElementById("user-detail-subtabs").innerHTML = tabs
    .map((t) => `<button class="games-admin-subtab${adminUserDetailSubtab === t.key ? " active" : ""}" data-user-subtab="${t.key}">${t.label}</button>`)
    .join("");
  document.querySelectorAll("[data-user-subtab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      adminUserDetailSubtab = btn.dataset.userSubtab;
      renderUserDetailModal();
    });
  });

  const content = document.getElementById("user-detail-content");
  if (adminUserDetailSubtab === "deposits") {
    content.innerHTML = adminUsersTable(
      ["Amount", "Note", "Status", "Requested", "Reviewed"],
      u.deposits.map((d) => [d.amount, escapeHtml(d.note || "—"), `<span class="badge ${d.status === "approved" ? "active" : d.status === "rejected" ? "locked" : "pending"}">${d.status}</span>`, formatDate(d.createdAt), d.reviewedAt ? formatDate(d.reviewedAt) : "—"]),
      "No deposit requests."
    );
  } else if (adminUserDetailSubtab === "withdrawals") {
    content.innerHTML = adminUsersTable(
      ["Amount", "Send To", "Status", "Requested", "Reviewed"],
      u.withdrawals.map((w) => [w.amount, escapeHtml(w.payoutDetails), `<span class="badge ${w.status === "approved" ? "active" : w.status === "rejected" ? "locked" : "pending"}">${w.status}</span>`, formatDate(w.createdAt), w.reviewedAt ? formatDate(w.reviewedAt) : "—"]),
      "No withdrawal requests."
    );
  } else if (adminUserDetailSubtab === "wallet-ledger") {
    content.innerHTML = adminUsersTable(
      ["Game", "Amount", "Type", "Time"],
      u.walletLedger.map((l) => [escapeHtml(l.gameId.replace(/_/g, " ")), l.amount, escapeHtml(l.transactionType), formatDate(l.createdAt)]),
      "No game wallet activity."
    );
  } else if (adminUserDetailSubtab === "bets") {
    content.innerHTML = adminUsersTable(
      ["Game", "Bet Type", "Amount", "Status", "Settled", "Time"],
      u.recentBets.map((b) => [escapeHtml(b.gameId.replace(/_/g, " ")), escapeHtml(b.betType), b.betAmount, `<span class="badge ${b.status === "won" || b.status === "cashed" ? "active" : b.status === "lost" ? "locked" : "pending"}">${b.status}</span>`, b.settledAmount, formatDate(b.createdAt)]),
      "No game bets yet."
    );
  } else if (adminUserDetailSubtab === "adjustments") {
    content.innerHTML = adminUsersTable(
      ["Amount", "Reason", "Balance Before → After", "By", "Time"],
      u.adjustments.map((a) => [a.amount, escapeHtml(a.reason), `${a.balanceBefore} → ${a.balanceAfter}`, escapeHtml(a.adminName), formatDate(a.createdAt)]),
      "No manual adjustments."
    );
  } else if (adminUserDetailSubtab === "status-changes") {
    content.innerHTML = adminUsersTable(
      ["New Status", "Reason", "Changed By", "Time"],
      u.statusChanges.map((s) => [`<span class="badge ${s.newStatus}">${s.newStatus}</span>`, escapeHtml(s.reason || "—"), `${escapeHtml(s.changedByName)} (${s.changedByRole})`, formatDate(s.createdAt)]),
      "No status changes yet."
    );
  }

  const lockBtn = document.getElementById("user-detail-toggle-lock");
  lockBtn.textContent = u.status === "locked" ? "Unlock User" : "Lock User";
  lockBtn.className = u.status === "locked" ? "inline-btn" : "inline-btn danger";
  lockBtn.onclick = async () => {
    const endpoint = u.status === "locked" ? "unlock" : "lock";
    const reason = prompt(`Reason for ${endpoint === "lock" ? "locking" : "unlocking"} this user (optional):`) || null;
    await api(`/admin/users/${u.id}/${endpoint}`, { method: "POST", body: { reason } });
    adminUserDetailCache = await api(`/admin/users/${u.id}`);
    renderUserDetailModal();
    loadAllUsers();
  };

  const transferBtn = document.getElementById("user-detail-transfer");
  transferBtn.onclick = () => {
    if (window.openTransferUserModal) window.openTransferUserModal(u);
  };
}

window.refreshUserDetailAfterTransfer = async function refreshUserDetailAfterTransfer() {
  if (!adminUserDetailCache) return;
  adminUserDetailCache = await api(`/admin/users/${adminUserDetailCache.id}`);
  renderUserDetailModal();
};

document.getElementById("user-detail-close")?.addEventListener("click", () => {
  document.getElementById("user-detail-modal").classList.add("hidden");
});

document.getElementById("user-adjust-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const amount = Number(document.getElementById("adjust-amount").value);
  const reason = document.getElementById("adjust-reason").value.trim();
  const noteEl = document.getElementById("adjust-note");
  noteEl.textContent = "";
  noteEl.className = "form-note";
  try {
    await api(`/admin/users/${adminUserDetailCache.id}/adjust-balance`, { method: "POST", body: { amount, reason } });
    document.getElementById("user-adjust-form").reset();
    noteEl.textContent = "Adjustment applied.";
    noteEl.className = "form-note success";
    adminUserDetailCache = await api(`/admin/users/${adminUserDetailCache.id}`);
    renderUserDetailModal();
    loadAllUsers();
  } catch (err) {
    noteEl.textContent = err.message;
    noteEl.className = "form-note error";
  }
});

// ---- Sub-admin performance ----
async function loadSubadminPerformance() {
  const rows = await api("/admin/subadmins/performance");
  const body = document.getElementById("subadmin-performance-body");
  if (!body) return;
  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">No sub-admins yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (s) => `
    <tr>
      <td>${escapeHtml(s.name)}</td>
      <td>${s.userCount}</td>
      <td>${s.totalUserBalance}</td>
      <td>${s.deposits.approved} approved (${s.deposits.approvedVolume}) · ${s.deposits.pending} pending · ${s.deposits.rejected} rejected</td>
      <td>${s.withdrawals.approved} approved (${s.withdrawals.approvedVolume}) · ${s.withdrawals.pending} pending · ${s.withdrawals.rejected} rejected</td>
      <td>${s.avgApprovalMinutes != null ? s.avgApprovalMinutes + " min" : "—"}</td>
    </tr>`
    )
    .join("");
}

window.initAdminUsersPanel = function initAdminUsersPanel() {
  loadAllUsers();
  loadSubadminPerformance();
};
