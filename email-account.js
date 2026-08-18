// Shared "Email Address" card -- add/verify/change the current account's
// recovery email. Mounted identically into the user dashboard's Profile
// tab, and into the admin/sub-admin dashboards' Overview tab (so admins and
// sub-admins can add their own recovery email too, since forgot-password
// now requires one for every role). Talks to the role-agnostic
// /api/account/email* endpoints -- same widget, same backend, no
// per-role duplication.
//
// IMPORTANT: the OTP step below builds its DOM exactly once per entry into
// "otp" mode. The resend countdown updates only the resend button's text
// via direct DOM mutation on a 1s interval -- it must NEVER call the full
// render() (which replaces container.innerHTML), or every tick would
// destroy and recreate the OTP <input>, wiping out whatever the user had
// just typed. (This was a real bug here previously -- fixed.)

function initEmailCard(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let state = { email: null, emailVerified: false };
  let mode = "view"; // view | edit | otp
  let cooldownTimer = null;
  let cooldownUntil = 0;
  let pendingEmail = null;

  async function load() {
    try {
      state = await api("/account/email");
    } catch {
      state = { email: null, emailVerified: false };
    }
    mode = "view";
    stopCooldown();
    render();
  }

  function stopCooldown() {
    if (cooldownTimer) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
    cooldownUntil = 0;
  }

  function cooldownRemaining() {
    return Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  }

  // Updates only the resend button's label/disabled state -- never touches
  // the OTP input, so it's safe to call every second while the user types.
  function updateResendButton() {
    const btn = document.getElementById("email-card-resend");
    if (!btn) return;
    const remaining = cooldownRemaining();
    btn.disabled = remaining > 0;
    btn.textContent = remaining > 0 ? `Resend OTP (${remaining}s)` : "Resend OTP";
  }

  function startCooldown(seconds) {
    cooldownUntil = Date.now() + seconds * 1000;
    if (cooldownTimer) clearInterval(cooldownTimer);
    updateResendButton();
    cooldownTimer = setInterval(() => {
      if (Date.now() >= cooldownUntil) stopCooldown();
      updateResendButton();
    }, 1000);
  }

  function render() {
    if (mode === "view") {
      container.innerHTML = state.email
        ? `
          <div class="email-card-row">
            <div>
              <span class="email-card-address">${escapeHtml(state.email)}</span>
              ${state.emailVerified ? `<span class="email-badge verified">✓ Verified</span>` : `<span class="email-badge unverified">Not Verified</span>`}
            </div>
            <button type="button" class="inline-btn ghost" id="email-card-action" data-testid="email-card-action">
              ${state.emailVerified ? "Change Email" : "Verify Now"}
            </button>
          </div>
          <p class="form-note" id="email-card-note"></p>
        `
        : `
          <div class="email-card-row">
            <span class="hint">Not added</span>
            <button type="button" class="inline-btn ghost" id="email-card-action" data-testid="email-card-action">Add Email</button>
          </div>
          <p class="form-note" id="email-card-note"></p>
        `;
      document.getElementById("email-card-action").addEventListener("click", () => {
        if (state.email && !state.emailVerified) {
          // Already have a pending unverified email -- go straight to OTP
          // entry without triggering a fresh send (one may already be en
          // route, e.g. from registration); the Resend button is enabled
          // immediately since no send just happened from this action.
          mode = "otp";
        } else {
          mode = "edit";
        }
        render();
      });
    } else if (mode === "edit") {
      container.innerHTML = `
        <div class="email-card-form">
          ${state.email ? `<p class="hint" style="margin:0 0 0.5rem;">Current: ${escapeHtml(state.email)}${state.emailVerified ? " (verified)" : ""}</p>` : ""}
          <label for="email-card-input">${state.emailVerified ? "New Email" : "Email Address"}</label>
          <input type="email" id="email-card-input" placeholder="you@example.com" data-testid="email-card-input">
          <div class="email-card-actions">
            <button type="button" class="inline-btn ghost" id="email-card-cancel">Cancel</button>
            <button type="button" class="inline-btn" id="email-card-send" data-testid="email-card-send">Send OTP</button>
          </div>
          <p class="form-note" id="email-card-note"></p>
        </div>
      `;
      document.getElementById("email-card-cancel").addEventListener("click", () => {
        mode = "view";
        render();
      });
      const sendBtn = document.getElementById("email-card-send");
      let sending = false;
      sendBtn.addEventListener("click", async () => {
        if (sending) return; // prevent duplicate submit on rapid double-click
        const email = document.getElementById("email-card-input").value.trim();
        const note = document.getElementById("email-card-note");
        note.textContent = "";
        note.className = "form-note";
        if (!email) {
          note.textContent = "Enter an email address.";
          note.className = "form-note error";
          return;
        }
        sending = true;
        sendBtn.disabled = true;
        try {
          const res = await api("/account/email/send-otp", { method: "POST", body: { email } });
          pendingEmail = res.email;
          mode = "otp";
          render();
          startCooldown(60);
        } catch (err) {
          note.textContent = err.message;
          note.className = "form-note error";
        } finally {
          sending = false;
          if (sendBtn.isConnected) sendBtn.disabled = false;
        }
      });
    } else if (mode === "otp") {
      // Built exactly once per entry into this mode -- see file header.
      container.innerHTML = `
        <div class="email-card-form">
          <p class="hint" style="margin:0 0 0.5rem;">Enter the 6-digit OTP sent to ${escapeHtml(pendingEmail || state.email || "your email")}.</p>
          <label for="email-card-otp">OTP</label>
          <input type="text" id="email-card-otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" data-testid="email-card-otp">
          <div class="email-card-actions">
            <button type="button" class="inline-btn ghost" id="email-card-cancel">Cancel</button>
            <button type="button" class="inline-btn" id="email-card-verify" data-testid="email-card-verify" disabled>Verify</button>
          </div>
          <button type="button" class="fp-resend-link" id="email-card-resend">Resend OTP</button>
          <p class="form-note" id="email-card-note"></p>
        </div>
      `;
      document.getElementById("email-card-cancel").addEventListener("click", () => {
        stopCooldown();
        mode = "view";
        render();
      });

      const otpInput = document.getElementById("email-card-otp");
      const verifyBtn = document.getElementById("email-card-verify");

      // Digits only (also normalizes a pasted code that includes spaces/
      // dashes), and only allow verifying once all 6 digits are present.
      // A plain text input already accepts paste natively -- this handler
      // fires for typed and pasted input alike via the `input` event.
      otpInput.addEventListener("input", () => {
        const digitsOnly = otpInput.value.replace(/\D/g, "").slice(0, 6);
        if (digitsOnly !== otpInput.value) otpInput.value = digitsOnly;
        verifyBtn.disabled = digitsOnly.length !== 6;
      });
      otpInput.focus();

      let verifying = false;
      verifyBtn.addEventListener("click", async () => {
        if (verifying) return; // prevent duplicate verification requests
        const otp = otpInput.value.trim();
        const note = document.getElementById("email-card-note");
        note.textContent = "";
        note.className = "form-note";
        if (otp.length !== 6) {
          note.textContent = "Enter the 6-digit OTP.";
          note.className = "form-note error";
          return;
        }
        verifying = true;
        verifyBtn.disabled = true;
        try {
          await api("/account/email/verify", { method: "POST", body: { otp } });
          stopCooldown();
          await load();
          const successNote = document.getElementById("email-card-note");
          if (successNote) {
            successNote.textContent = "Email verified.";
            successNote.className = "form-note success";
          }
        } catch (err) {
          note.textContent = err.message;
          note.className = "form-note error";
          verifying = false;
          if (verifyBtn.isConnected) verifyBtn.disabled = otpInput.value.replace(/\D/g, "").length !== 6;
        }
      });

      document.getElementById("email-card-resend").addEventListener("click", async () => {
        if (cooldownRemaining() > 0) return;
        const note = document.getElementById("email-card-note");
        try {
          await api("/account/email/send-otp", { method: "POST", body: pendingEmail ? { email: pendingEmail } : {} });
          note.textContent = "A new OTP has been sent.";
          note.className = "form-note success";
          startCooldown(60);
        } catch (err) {
          note.textContent = err.message;
          note.className = "form-note error";
        }
      });

      updateResendButton();
    }
  }

  load();
}
