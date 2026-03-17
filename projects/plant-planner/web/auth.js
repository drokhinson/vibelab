// auth.js — Login / Register views

function renderAuth() {
  app.innerHTML = '\
    <article>\
      <header><h3>Welcome to PlantPlanner</h3></header>\
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
