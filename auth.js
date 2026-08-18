const tabs = document.querySelectorAll(".auth-tab");
const highlight = document.getElementById("auth-tab-highlight");
const forms = {
  "login-form": document.getElementById("login-form"),
  "register-form": document.getElementById("register-form"),
};

function switchTo(target) {
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.target === target));
  highlight.classList.toggle("to-register", target === "register-form");
  Object.values(forms).forEach((form) => form.classList.add("hidden"));
  forms[target].classList.remove("hidden");
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => switchTo(tab.dataset.target));
});

document.querySelectorAll(".switch-link").forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    switchTo(link.dataset.target);
  });
});

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get("tab") === "register") {
  switchTo("register-form");
}
const refFromUrl = urlParams.get("ref");
if (refFromUrl) {
  document.getElementById("register-referral").value = refFromUrl.trim().toUpperCase();
}

const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setError(id, message) {
  document.getElementById(id).textContent = message || "";
}

function clearErrors(ids) {
  ids.forEach((id) => setError(id, ""));
}

function setMessage(id, message, isError) {
  const el = document.getElementById(id);
  el.textContent = message || "";
  el.style.color = isError ? "#ff8383" : "";
}

function afterAuth(data) {
  localStorage.setItem("fe_token", data.token);
  localStorage.setItem("fe_role", data.role);
  localStorage.setItem("fe_name", data.name);
  window.location.href = "user-dashboard.html";
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErrors(["login-phone-error", "login-password-error"]);
  setMessage("login-message", "", false);

  const phone = document.getElementById("login-phone").value.trim();
  const password = document.getElementById("login-password").value;
  let valid = true;

  if (!INDIAN_MOBILE_REGEX.test(phone)) {
    setError("login-phone-error", "Enter a valid 10-digit mobile number.");
    valid = false;
  }
  if (password.length < 6) {
    setError("login-password-error", "Password must be at least 6 characters.");
    valid = false;
  }
  if (!valid) return;

  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMessage("login-message", data.error || "Login failed.", true);
      return;
    }
    setMessage("login-message", `Welcome back, ${data.name}!`, false);
    afterAuth(data);
  } catch {
    setMessage("login-message", "Could not reach the server. Please try again.", true);
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErrors([
    "register-name-error",
    "register-phone-error",
    "register-email-error",
    "register-password-error",
    "register-confirm-error",
    "register-referral-error",
  ]);
  setMessage("register-message", "", false);

  const name = document.getElementById("register-name").value.trim();
  const phone = document.getElementById("register-phone").value.trim();
  const email = document.getElementById("register-email").value.trim().toLowerCase();
  const password = document.getElementById("register-password").value;
  const confirm = document.getElementById("register-confirm").value;
  const referralCode = document.getElementById("register-referral").value.trim();
  let valid = true;

  if (name.length < 2) {
    setError("register-name-error", "Please enter your full name.");
    valid = false;
  }
  if (!INDIAN_MOBILE_REGEX.test(phone)) {
    setError("register-phone-error", "Enter a valid 10-digit mobile number.");
    valid = false;
  }
  if (!EMAIL_REGEX.test(email)) {
    setError("register-email-error", "Enter a valid email address.");
    valid = false;
  }
  if (password.length < 6) {
    setError("register-password-error", "Password must be at least 6 characters.");
    valid = false;
  }
  if (confirm !== password) {
    setError("register-confirm-error", "Passwords do not match.");
    valid = false;
  }
  if (!valid) return;

  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, phone, email, password, referralCode: referralCode || undefined }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (referralCode && /referral code/i.test(data.error || "")) {
        setError("register-referral-error", data.error);
      } else {
        setMessage("register-message", data.error || "Registration failed.", true);
      }
      return;
    }
    setMessage("register-message", `Account created for ${data.name}! We've sent a verification code to ${data.email} — verify it from your Profile tab.`, false);
    afterAuth(data);
  } catch {
    setMessage("register-message", "Could not reach the server. Please try again.", true);
  } finally {
    submitBtn.disabled = false;
  }
});
