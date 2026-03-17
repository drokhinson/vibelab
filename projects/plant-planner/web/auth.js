// auth.js — Login / Register views

function renderAuth() {
  app.innerHTML = '\
    <article>\
      <header><h3>Welcome to PlantPlanner</h3></header>\
      <div class="auth-illustration">\
        <svg width="180" height="120" viewBox="0 0 180 120" fill="none" xmlns="http://www.w3.org/2000/svg">\
          <rect x="20" y="75" width="140" height="30" rx="8" fill="var(--pico-primary)" opacity="0.12"/>\
          <rect x="25" y="70" width="130" height="10" rx="4" fill="var(--pico-primary)" opacity="0.22"/>\
          <path d="M50 70 Q48 45 40 30 Q48 38 50 25 Q52 38 60 30 Q52 45 50 70Z" fill="var(--pico-primary)" opacity="0.55"/>\
          <path d="M90 70 Q88 35 78 15 Q88 28 90 10 Q92 28 102 15 Q92 35 90 70Z" fill="var(--pico-primary)" opacity="0.7"/>\
          <path d="M130 70 Q128 48 120 35 Q128 42 130 30 Q132 42 140 35 Q132 48 130 70Z" fill="var(--pico-primary)" opacity="0.5"/>\
          <circle cx="78" cy="18" r="6" fill="var(--pp-accent, #e8c84a)" opacity="0.8"/>\
          <circle cx="102" cy="14" r="5" fill="var(--pp-accent, #e8c84a)" opacity="0.7"/>\
          <circle cx="40" cy="32" r="4" fill="var(--pp-accent, #e8c84a)" opacity="0.6"/>\
          <circle cx="140" cy="36" r="3.5" fill="var(--pp-accent, #e8c84a)" opacity="0.55"/>\
          <rect x="60" y="85" width="10" height="10" rx="2" fill="var(--pico-primary)" opacity="0.08" stroke="var(--pico-primary)" stroke-width="0.5" stroke-opacity="0.2"/>\
          <rect x="75" y="85" width="10" height="10" rx="2" fill="var(--pico-primary)" opacity="0.08" stroke="var(--pico-primary)" stroke-width="0.5" stroke-opacity="0.2"/>\
          <rect x="90" y="85" width="10" height="10" rx="2" fill="var(--pico-primary)" opacity="0.15" stroke="var(--pico-primary)" stroke-width="0.5" stroke-opacity="0.2"/>\
          <rect x="105" y="85" width="10" height="10" rx="2" fill="var(--pico-primary)" opacity="0.08" stroke="var(--pico-primary)" stroke-width="0.5" stroke-opacity="0.2"/>\
          <text x="82" y="93" font-size="7" fill="var(--pico-primary)" opacity="0.5">🌱</text>\
        </svg>\
      </div>\
      <p class="muted">Plan your perfect garden with drag-and-drop simplicity.</p>\
      <div id="auth-error"></div>\
      <div id="auth-form">' + loginFormHTML() + '</div>\
      <footer class="muted" style="text-align:center">\
        <a href="#" id="auth-toggle">Need an account? Register</a>\
      </footer>\
    </article>';
  var isLogin = true;
  document.getElementById("auth-toggle").onclick = function(e) {
    e.preventDefault();
    isLogin = !isLogin;
    document.getElementById("auth-form").innerHTML = isLogin ? loginFormHTML() : registerFormHTML();
    e.target.textContent = isLogin ? "Need an account? Register" : "Already have an account? Login";
    bindAuthSubmit(isLogin);
  };
  bindAuthSubmit(true);
}

function loginFormHTML() {
  return '\
    <form id="auth-submit">\
      <input type="text" name="username" placeholder="Username" required />\
      <input type="password" name="password" placeholder="Password" required />\
      <button type="submit">Login</button>\
    </form>';
}

function registerFormHTML() {
  return '\
    <form id="auth-submit">\
      <input type="text" name="username" placeholder="Username" required />\
      <input type="text" name="display_name" placeholder="Display Name (optional)" />\
      <input type="password" name="password" placeholder="Password" required />\
      <button type="submit">Register</button>\
    </form>';
}

function bindAuthSubmit(isLogin) {
  var form = document.getElementById("auth-submit");
  if (!form) return;
  form.onsubmit = async function(e) {
    e.preventDefault();
    var errEl = document.getElementById("auth-error");
    errEl.innerHTML = "";
    var fd = new FormData(form);
    var body = { username: fd.get("username"), password: fd.get("password") };
    if (!isLogin && fd.get("display_name")) body.display_name = fd.get("display_name");
    var btn = form.querySelector("button");
    btn.setAttribute("aria-busy", "true");
    btn.disabled = true;
    try {
      var endpoint = isLogin ? "/auth/login" : "/auth/register";
      var data = await apiFetch(endpoint, { method: "POST", body: body });
      setToken(data.token);
      currentUser = data.user;
      await loadPlants();
      showView("gardens");
    } catch (err) {
      errEl.innerHTML = '<div class="error-banner">' + err.message + '</div>';
    } finally {
      btn.setAttribute("aria-busy", "false");
      btn.disabled = false;
    }
  };
}

async function loadPlants() {
  plants = await apiFetch("/plants");
}
