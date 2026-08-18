// Forgot Password / OTP reset flow -- shared by login.html (users) and
// admin-login.html (admin + sub-admin). One implementation, reused from
// both pages instead of a duplicated per-role reset system. Password
// recovery goes through a *verified email* (never phone/username alone) --
// see server/routes/auth.js's /forgot-password, /verify-reset-otp,
// /reset-password.
//
// Expects the modal markup (fp-step-email / fp-step-otp / fp-step-reset /
// fp-step-done) to be present on the page and a trigger element with
// id="forgot-password-link".

(function () {
  let resetEmail = "";
  let resetToken = "";
  let resendCooldownUntil = 0;
  let resendCooldownTimer = null;

  function el(id) {
    return document.getElementById(id);
  }

  function showStep(step) {
    ["fp-step-email", "fp-step-otp", "fp-step-reset", "fp-step-done"].forEach((id) => {
      el(id).classList.toggle("hidden", id !== `fp-step-${step}`);
    });
  }

  function setMsg(id, message, isError) {
    const node = el(id);
    node.textContent = message || "";
    node.style.color = isError ? "#ff8383" : "";
  }

  function openModal() {
    resetEmail = "";
    resetToken = "";
    el("fp-email-input").value = "";
    el("fp-otp-input").value = "";
    el("fp-new-password").value = "";
    el("fp-confirm-password").value = "";
    setMsg("fp-email-msg", "", false);
    setMsg("fp-otp-msg", "", false);
    setMsg("fp-reset-msg", "", false);
    showStep("email");
    el("forgot-password-modal").classList.remove("hidden");
  }

  function closeModal() {
    el("forgot-password-modal").classList.add("hidden");
    if (resendCooldownTimer) {
      clearInterval(resendCooldownTimer);
      resendCooldownTimer = null;
    }
  }

  async function postJson(path, body) {
    const res = await fetch(`/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function startResendCooldown(seconds) {
    resendCooldownUntil = Date.now() + seconds * 1000;
    const btn = el("fp-resend-otp-btn");
    if (resendCooldownTimer) clearInterval(resendCooldownTimer);
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((resendCooldownUntil - Date.now()) / 1000));
      if (remaining <= 0) {
        btn.disabled = false;
        btn.textContent = "Resend OTP";
        clearInterval(resendCooldownTimer);
        resendCooldownTimer = null;
      } else {
        btn.disabled = true;
        btn.textContent = `Resend OTP (${remaining}s)`;
      }
    };
    tick();
    resendCooldownTimer = setInterval(tick, 1000);
  }

  async function sendOtp() {
    const email = el("fp-email-input").value.trim();
    setMsg("fp-email-msg", "", false);
    if (!isValidEmail(email)) {
      setMsg("fp-email-msg", "Enter a valid email address.", true);
      return;
    }
    const btn = el("fp-send-otp-btn");
    btn.disabled = true;
    try {
      await postJson("/auth/forgot-password", { email });
      resetEmail = email;
      el("fp-otp-email-label").textContent = email;
      showStep("otp");
      startResendCooldown(60);
    } catch (err) {
      setMsg("fp-email-msg", err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function verifyOtp() {
    const otp = el("fp-otp-input").value.trim();
    setMsg("fp-otp-msg", "", false);
    if (!otp) {
      setMsg("fp-otp-msg", "Enter the OTP you received.", true);
      return;
    }
    const btn = el("fp-verify-otp-btn");
    btn.disabled = true;
    try {
      const data = await postJson("/auth/verify-reset-otp", { email: resetEmail, otp });
      resetToken = data.resetToken;
      showStep("reset");
    } catch (err) {
      setMsg("fp-otp-msg", err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function resendOtp() {
    if (Date.now() < resendCooldownUntil) return;
    setMsg("fp-otp-msg", "", false);
    try {
      await postJson("/auth/forgot-password", { email: resetEmail });
      setMsg("fp-otp-msg", "A new OTP has been sent.", false);
      startResendCooldown(60);
    } catch (err) {
      setMsg("fp-otp-msg", err.message, true);
    }
  }

  async function submitNewPassword() {
    const newPassword = el("fp-new-password").value;
    const confirmPassword = el("fp-confirm-password").value;
    setMsg("fp-reset-msg", "", false);

    if (newPassword.length < 6) {
      setMsg("fp-reset-msg", "Password must be at least 6 characters.", true);
      return;
    }
    if (newPassword !== confirmPassword) {
      setMsg("fp-reset-msg", "Passwords do not match.", true);
      return;
    }

    const btn = el("fp-reset-btn");
    btn.disabled = true;
    try {
      await postJson("/auth/reset-password", { resetToken, newPassword, confirmPassword });
      showStep("done");
      if (resendCooldownTimer) {
        clearInterval(resendCooldownTimer);
        resendCooldownTimer = null;
      }
    } catch (err) {
      setMsg("fp-reset-msg", err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const trigger = el("forgot-password-link");
    if (!trigger || !el("forgot-password-modal")) return;

    trigger.addEventListener("click", (e) => {
      e.preventDefault();
      openModal();
    });
    el("fp-modal-close").addEventListener("click", closeModal);
    el("forgot-password-modal").addEventListener("click", (e) => {
      if (e.target.id === "forgot-password-modal") closeModal();
    });
    el("fp-send-otp-btn").addEventListener("click", sendOtp);
    el("fp-verify-otp-btn").addEventListener("click", verifyOtp);
    el("fp-resend-otp-btn").addEventListener("click", resendOtp);
    el("fp-reset-btn").addEventListener("click", submitNewPassword);
    el("fp-done-close-btn").addEventListener("click", closeModal);
  });
})();
