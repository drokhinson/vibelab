// auth.js — Login / Register views (Supabase Auth)

function renderAuth() {
  app.innerHTML = '\
    <div class="max-w-sm mx-auto mt-12">\
      <div class="card bg-base-100 shadow-lg rounded-2xl">\
        <div class="card-body items-center text-center">\
          <h3 class="card-title font-display text-xl mb-1">Welcome to PlantPlanner</h3>\
          <div class="auth-illustration">\
            <svg width="180" height="120" viewBox="0 0 180 120" fill="none" xmlns="http://www.w3.org/2000/svg">\
              <rect x="20" y="75" width="140" height="30" rx="8" fill="#7BAE7F" opacity="0.12"/>\
              <rect x="25" y="70" width="130" height="10" rx="4" fill="#7BAE7F" opacity="0.22"/>\
              <path d="M50 70 Q48 45 40 30 Q48 38 50 25 Q52 38 60 30 Q52 45 50 70Z" fill="#7BAE7F" opacity="0.55"/>\
              <path d="M90 70 Q88 35 78 15 Q88 28 90 10 Q92 28 102 15 Q92 35 90 70Z" fill="#7BAE7F" opacity="0.7"/>\
              <path d="M130 70 Q128 48 120 35 Q128 42 130 30 Q132 42 140 35 Q132 48 130 70Z" fill="#7BAE7F" opacity="0.5"/>\
              <circle cx="78" cy="18" r="6" fill="#E8856C" opacity="0.8"/>\
              <circle cx="102" cy="14" r="5" fill="#E8856C" opacity="0.7"/>\
              <circle cx="40" cy="32" r="4" fill="#B8A9D4" opacity="0.6"/>\
              <circle cx="140" cy="36" r="3.5" fill="#B8A9D4" opacity="0.55"/>\
              <rect x="60" y="85" width="10" height="10" rx="2" fill="#7BAE7F" opacity="0.08" stroke="#7BAE7F" stroke-width="0.5" stroke-opacity="0.2"/>\
              <rect x="75" y="85" width="10" height="10" rx="2" fill="#7BAE7F" opacity="0.08" stroke="#7BAE7F" stroke-width="0.5" stroke-opacity="0.2"/>\
              <rect x="90" y="85" width="10" height="10" rx="2" fill="#7BAE7F" opacity="0.15" stroke="#7BAE7F" stroke-width="0.5" stroke-opacity="0.2"/>\
              <rect x="105" y="85" width="10" height="10" rx="2" fill="#7BAE7F" opacity="0.08" stroke="#7BAE7F" stroke-width="0.5" stroke-opacity="0.2"/>\
            </svg>\
          </div>\
          <p class="text-sm text-base-content/50 mb-3">Plan your perfect garden with drag-and-drop simplicity.</p>\
          <div id="auth-error" class="w-full"></div>\
          <div id="auth-form" class="w-full">' + loginFormHTML() + '</div>\
          <div class="mt-3">\
            <a href="#" id="auth-toggle" class="link link-primary text-sm">Need an account? Register</a>\
          </div>\
        </div>\
      </div>\
    </div>';
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
    <form id="auth-submit" class="space-y-3 w-full">\
      <input type="email" name="email" placeholder="Email" required class="input input-bordered w-full input-sm" />\
      <input type="password" name="password" placeholder="Password" required class="input input-bordered w-full input-sm" />\
      <button type="submit" class="btn btn-primary w-full btn-sm">Login</button>\
    </form>';
}

function registerFormHTML() {
  return '\
    <form id="auth-submit" class="space-y-3 w-full">\
      <input type="email" name="email" placeholder="Email" required class="input input-bordered w-full input-sm" />\
      <input type="text" name="username" placeholder="Username" required class="input input-bordered w-full input-sm" />\
      <input type="text" name="display_name" placeholder="Display Name (optional)" class="input input-bordered w-full input-sm" />\
      <input type="password" name="password" placeholder="Password (min 6 chars)" required minlength="6" class="input input-bordered w-full input-sm" />\
      <button type="submit" class="btn btn-primary w-full btn-sm">Register</button>\
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
    var btn = form.querySelector("button");
    btn.classList.add("loading");
    btn.disabled = true;
    try {
      if (isLogin) {
        var { data, error } = await sb.auth.signInWithPassword({
          email: fd.get("email"),
          password: fd.get("password"),
        });
        if (error) throw new Error(error.message);
        // Fetch existing profile
        currentUser = await apiFetch("/auth/me");
      } else {
        var { data, error } = await sb.auth.signUp({
          email: fd.get("email"),
          password: fd.get("password"),
        });
        if (error) throw new Error(error.message);
        if (!data.session) throw new Error("Check your email to confirm your account.");
        // Create profile in backend
        var profileData = await apiFetch("/auth/profile", {
          method: "POST",
          body: {
            username: fd.get("username"),
            display_name: fd.get("display_name") || fd.get("username"),
          },
        });
        currentUser = profileData.user;
      }
      await loadPlants();
      try { preloadThumbnails(plants, renderStyle); } catch (_) {}
      showView("gardens");
    } catch (err) {
      errEl.innerHTML = '<div class="error-banner">' + err.message + '</div>';
    } finally {
      btn.classList.remove("loading");
      btn.disabled = false;
    }
  };
}

async function loadPlants() {
  plants = await apiFetch("/plants");
}
