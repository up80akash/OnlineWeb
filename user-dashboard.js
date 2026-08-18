requireRole("user");

function setNote(id, message, type) {
  const el = document.getElementById(id);
  el.textContent = message || "";
  el.className = "form-note" + (type ? ` ${type}` : "");
}

// Game modules only ever have a single up-to-date number (the total
// wallet_balance returned by their own bet/state endpoints) to push here
// after every action, so this accepts either that raw number (updates just
// the always-visible header pill) or the full /user/me object (updates the
// pill plus the full Wallet-tab breakdown). Keeping one function name for
// both keeps every existing game module's setBalance(res.walletBalance)
// call site working unchanged.
function setBalance(meOrAmount) {
  if (typeof meOrAmount === "number") {
    document.getElementById("wallet-pill").textContent = `${meOrAmount} tokens`;
    return;
  }
  const me = meOrAmount;
  document.getElementById("wallet-pill").textContent = `${me.walletBalance} tokens`;
  document.getElementById("wallet-balance").textContent = me.walletBalance;
  document.getElementById("wallet-deposit-balance").textContent = me.depositBalance;
  document.getElementById("wallet-referral-balance").textContent = me.referralBalance;
  document.getElementById("wallet-winning-balance").textContent = me.winningBalance;
  document.getElementById("wallet-withdrawable-balance").textContent = me.withdrawableBalance;
}

async function loadMe() {
  const me = await api("/user/me");
  setBalance(me);
  document.getElementById("profile-name").textContent = me.name;
  document.getElementById("profile-phone").textContent = `+91 ${me.phone}`;
  document.getElementById("profile-status").textContent = me.status;
  document.getElementById("profile-created").textContent = formatDate(me.createdAt);
  document.getElementById("profile-subadmin").textContent = me.subAdmin
    ? `${me.subAdmin.name} (+91 ${me.subAdmin.phone})`
    : "Not assigned yet";
}

async function loadWalletTransactions() {
  const rows = await api("/user/wallet/transactions");
  const body = document.getElementById("wallet-tx-body");
  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">No wallet transactions yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.type)}</td>
      <td>${r.amount > 0 ? "+" : ""}${r.amount}</td>
      <td>${r.balanceAfter}</td>
      <td>${r.referralBalanceAfter}</td>
      <td>${r.winningBalanceAfter}</td>
      <td>${formatDate(r.createdAt)}</td>
    </tr>`
    )
    .join("");
}

async function loadReferral() {
  const stats = await api("/user/referral");
  document.getElementById("referral-code").textContent = stats.referralCode;
  document.getElementById("referral-link").textContent = stats.referralLink;
  document.getElementById("referral-total").textContent = stats.totalReferred;
  document.getElementById("referral-qualified").textContent = stats.qualifiedReferred;
  document.getElementById("referral-reward-earned").textContent = stats.rewardEarned;
  document.getElementById("referral-total-earned").textContent = stats.totalEarned;

  const usersBody = document.getElementById("referral-users-body");
  usersBody.innerHTML = stats.referredUsers.length
    ? stats.referredUsers
        .map(
          (r) => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td>+91 ${escapeHtml(r.phone)}</td>
      <td><span class="badge ${r.status === "qualified" ? "approved" : "pending"}">${r.status}</span></td>
      <td>${formatDate(r.joinedAt)}</td>
      <td>${r.qualifiedAt ? formatDate(r.qualifiedAt) : "—"}</td>
    </tr>`
        )
        .join("")
    : `<tr class="empty-row"><td colspan="5">No referrals yet — share your link to start earning.</td></tr>`;

  const historyBody = document.getElementById("referral-history-body");
  historyBody.innerHTML = stats.history.length
    ? stats.history
        .map(
          (h) => `
    <tr>
      <td>${h.type === "REFERRAL_REWARD" ? "Referral Reward" : "Commission"}</td>
      <td>+${h.amount}</td>
      <td>${formatDate(h.createdAt)}</td>
    </tr>`
        )
        .join("")
    : `<tr class="empty-row"><td colspan="3">No earnings yet.</td></tr>`;
}

function copyToClipboard(text, btn) {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      const original = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = original), 1500);
    })
    .catch(() => alert("Could not copy — please copy it manually."));
}

document.getElementById("referral-copy-code-btn").addEventListener("click", (e) => {
  copyToClipboard(document.getElementById("referral-code").textContent, e.target);
});
document.getElementById("referral-copy-link-btn").addEventListener("click", (e) => {
  copyToClipboard(document.getElementById("referral-link").textContent, e.target);
});

async function loadPaymentMethods() {
  const rows = await api("/user/payment-methods");
  const list = document.getElementById("payment-methods-list");
  if (rows.length === 0) {
    list.innerHTML = `<p class="hint">No payment methods have been added by your support agent yet.</p>`;
  } else {
    list.innerHTML = rows
      .map(
        (r) => `
      <div style="padding: 0.75rem 0; border-bottom: 1px solid rgba(255,255,255,0.08);">
        <strong>${escapeHtml(r.method)}</strong>
        <div class="hint">${escapeHtml(r.details)}</div>
      </div>`
      )
      .join("");
  }

  const datalist = document.getElementById("deposit-method-options");
  const methods = [...new Set(rows.map((r) => r.method))];
  datalist.innerHTML = methods.map((m) => `<option value="${escapeHtml(m)}">`).join("");
}

async function loadDepositInstructions() {
  const info = await api("/user/deposit-instructions");
  document.getElementById("deposit-min-amount").textContent = info.minAmount;
  document.getElementById("deposit-max-amount").textContent = info.maxAmount;
  document.getElementById("deposit-instructions-text").textContent = info.instructions;
  document.getElementById("deposit-instructions-box").style.display = "block";
  document.getElementById("deposit-amount").min = info.minAmount;
  document.getElementById("deposit-amount").max = info.maxAmount;
}

async function loadDeposits() {
  const rows = await api("/user/deposits");
  const body = document.getElementById("deposits-body");
  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">No deposit requests yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${r.amount}</td>
      <td>${escapeHtml(r.paymentMethod || "—")}</td>
      <td>${escapeHtml(r.transactionReference || "—")}</td>
      <td><span class="badge ${r.status}">${r.status}</span></td>
      <td>${formatDate(r.createdAt)}</td>
      <td>${r.hasScreenshot ? `<button type="button" class="view-screenshot-btn" data-deposit-screenshot="${r.id}">View</button>` : "—"}</td>
    </tr>`
    )
    .join("");

  body.querySelectorAll("[data-deposit-screenshot]").forEach((btn) => {
    btn.addEventListener("click", () => openImageLightbox(`/user/deposits/${btn.dataset.depositScreenshot}/screenshot`));
  });
}

async function loadWithdrawals() {
  const rows = await api("/user/withdrawals");
  const body = document.getElementById("withdrawals-body");
  if (rows.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="4">No withdrawal requests yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${r.amount}</td>
      <td>${escapeHtml(r.payoutDetails)}</td>
      <td><span class="badge ${r.status}">${r.status}</span></td>
      <td>${formatDate(r.createdAt)}</td>
    </tr>`
    )
    .join("");
}

async function loadSupport() {
  const rows = await api("/user/support");
  const box = document.getElementById("chat-messages");
  if (rows.length === 0) {
    box.innerHTML = `<p class="chat-empty">No messages yet. Say hello to your support agent below.</p>`;
    return;
  }
  box.innerHTML = rows
    .map(
      (m) => `
    <div class="chat-bubble ${m.senderRole === "user" ? "mine" : "theirs"}">
      ${escapeHtml(m.message)}
      ${m.hasAttachment ? `<button type="button" class="chat-attachment" data-attachment-id="${m.id}">📎 View attachment</button>` : ""}
      <span class="meta">${m.senderRole === "user" ? "You" : "Support"} · ${formatDate(m.createdAt)}</span>
    </div>`
    )
    .join("");
  box.scrollTop = box.scrollHeight;
  box.querySelectorAll("[data-attachment-id]").forEach((btn) => {
    btn.addEventListener("click", () => openImageLightbox(`/user/support/${btn.dataset.attachmentId}/attachment`));
  });
}

const depositScreenshotPicker = initImagePicker({
  inputId: "deposit-screenshot",
  previewId: "deposit-screenshot-preview",
  dropZoneId: "deposit-screenshot-dropzone",
});

document.getElementById("deposit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setNote("deposit-note-msg", "", "");

  const amount = document.getElementById("deposit-amount").value;
  const paymentMethod = document.getElementById("deposit-method").value.trim();
  const transactionReference = document.getElementById("deposit-reference").value.trim();
  const note = document.getElementById("deposit-note").value.trim();
  const screenshot = depositScreenshotPicker?.getFile();

  if (!amount || !paymentMethod || !transactionReference || !screenshot) {
    setNote("deposit-note-msg", "Please complete all required fields, including the payment screenshot, before submitting your deposit request.", "error");
    return;
  }

  const formData = new FormData();
  formData.set("amount", amount);
  formData.set("paymentMethod", paymentMethod);
  formData.set("transactionReference", transactionReference);
  if (note) formData.set("note", note);
  formData.set("screenshot", screenshot);

  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    await apiUpload("/user/deposits", formData);
    document.getElementById("deposit-form").reset();
    depositScreenshotPicker?.reset();
    setNote("deposit-note-msg", "Deposit request submitted.", "success");
    loadDeposits();
    loadWalletTransactions();
  } catch (err) {
    setNote("deposit-note-msg", err.message, "error");
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById("withdraw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const amount = Number(document.getElementById("withdraw-amount").value);
  const payoutDetails = document.getElementById("withdraw-details").value.trim();
  setNote("withdraw-note-msg", "", "");
  try {
    await api("/user/withdrawals", { method: "POST", body: { amount, payoutDetails } });
    document.getElementById("withdraw-form").reset();
    setNote("withdraw-note-msg", "Withdrawal request submitted.", "success");
    await Promise.all([loadWithdrawals(), loadMe(), loadWalletTransactions()]);
  } catch (err) {
    setNote("withdraw-note-msg", err.message, "error");
  }
});

// ---- Chat attachment: a compact picker (attach icon + small preview chip)
// rather than the big dropzone used for deposits -- reuses the same
// client-side type/size checks inline since the UI shape differs enough
// that sharing initImagePicker's dropzone markup isn't a fit.
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
  const input = document.getElementById("chat-input");
  const message = input.value.trim();
  if (!message) return;
  try {
    const formData = new FormData();
    formData.set("message", message);
    if (chatAttachmentFile) formData.set("attachment", chatAttachmentFile);
    await apiUpload("/user/support", formData);
    input.value = "";
    setChatAttachment(null);
    document.getElementById("chat-attachment-input").value = "";
    loadSupport();
  } catch (err) {
    alert(err.message);
  }
});

loadMe();
loadDepositInstructions();
loadPaymentMethods();
loadDeposits();
loadWithdrawals();
loadWalletTransactions();
loadReferral();
loadSupport();
initEmailCard("email-card");

// Re-fetch a panel's data whenever it's switched to (see dashboard-common.js
// dispatchPanelShown) -- e.g. balances/history can go stale in the
// background while a game is played on the Games tab, so re-entering
// Wallet/Referral/Profile should never show numbers older than "now".
document.addEventListener("dash:panelshown", (e) => {
  if (e.detail.panel === "wallet") {
    loadMe();
    loadDeposits();
    loadWithdrawals();
    loadWalletTransactions();
  } else if (e.detail.panel === "referral") {
    loadReferral();
  } else if (e.detail.panel === "profile") {
    loadMe();
  } else if (e.detail.panel === "support") {
    loadSupport();
  }
});

function wireRefreshButton(id, fn) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await fn();
    } finally {
      btn.disabled = false;
    }
  });
}

wireRefreshButton("wallet-refresh-btn", () => Promise.all([loadMe(), loadDeposits(), loadWithdrawals(), loadWalletTransactions()]));
wireRefreshButton("referral-refresh-btn", loadReferral);
wireRefreshButton("profile-refresh-btn", loadMe);
