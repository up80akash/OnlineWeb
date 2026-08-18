const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;

document.getElementById("admin-login-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const phoneError = document.getElementById("admin-phone-error");
  const passwordError = document.getElementById("admin-password-error");
  const message = document.getElementById("admin-login-message");
  phoneError.textContent = "";
  passwordError.textContent = "";
  message.textContent = "";
  message.style.color = "";

  const phone = document.getElementById("admin-phone").value.trim();
  const password = document.getElementById("admin-password").value;
  let valid = true;

  if (!INDIAN_MOBILE_REGEX.test(phone)) {
    phoneError.textContent = "Enter a valid 10-digit mobile number.";
    valid = false;
  }
  if (!password) {
    passwordError.textContent = "Enter your password.";
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
      message.style.color = "#ff8383";
      message.textContent = data.error || "Login failed.";
      return;
    }

    localStorage.setItem("fe_token", data.token);
    localStorage.setItem("fe_role", data.role);
    localStorage.setItem("fe_name", data.name);

    window.location.href = data.role === "admin" ? "admin-dashboard.html" : "subadmin-dashboard.html";
  } catch {
    message.style.color = "#ff8383";
    message.textContent = "Could not reach the server. Please try again.";
  } finally {
    submitBtn.disabled = false;
  }
});
