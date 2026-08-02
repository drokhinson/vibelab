// admin.js — vibelab admin-code session (sessionStorage) + login modal.
// The code is sent as `Authorization: Bearer <code>` by api.js and validated
// server-side against ADMIN_API_KEY. Viewing needs no code; editing does.
(function () {
  const KEY = "tripguide_admin_key";

  function getKey() { try { return sessionStorage.getItem(KEY); } catch (_) { return null; } }
  function setKey(k) { try { sessionStorage.setItem(KEY, k); } catch (_) {} }
  function clearKey() { try { sessionStorage.removeItem(KEY); } catch (_) {} }
  function isAdmin() { return !!getKey(); }

  function emit() { document.dispatchEvent(new CustomEvent("admin-changed", { detail: { isAdmin: isAdmin() } })); }

  // Validate a freshly-entered code against the admin health probe.
  async function login(code) {
    setKey(code);
    try {
      await window.api.adminHealth();
      emit();
      return true;
    } catch (err) {
      clearKey();
      throw err;
    }
  }

  function logout() {
    clearKey();
    emit();
    window.toast("Signed out of admin", "info");
  }

  // Called by api.js when any request returns 401/403.
  function onUnauthorized() {
    if (!getKey()) return;
    clearKey();
    emit();
    window.toast("Admin session expired", "error");
  }

  function openLogin() {
    const { root, close } = window.Modal.open({
      title: "Admin sign-in",
      bodyHTML: `
        <p class="tg-modal__hint">Enter the vibelab admin code to add, edit, and reorder trips and stops.</p>
        <form id="admin-login-form">
          <input id="admin-code" type="password" class="input input-bordered w-full" placeholder="Admin code" autocomplete="off" />
          <p id="admin-err" class="tg-form-err hidden"></p>
        </form>`,
      footerHTML: `
        <button class="btn btn-ghost" data-cancel>Cancel</button>
        <button class="btn btn-primary" data-submit>Sign in</button>`,
    });
    const input = root.querySelector("#admin-code");
    const errEl = root.querySelector("#admin-err");
    input.focus();

    async function submit() {
      const code = input.value.trim();
      if (!code) { input.focus(); return; }
      errEl.classList.add("hidden");
      const btn = root.querySelector("[data-submit]");
      btn.disabled = true;
      btn.classList.add("loading");
      try {
        await login(code);
        close();
        window.toast("Admin mode on", "success");
      } catch (err) {
        errEl.textContent = err.status === 403 ? "That code was not accepted." : (err.message || "Sign-in failed.");
        errEl.classList.remove("hidden");
        btn.disabled = false;
        btn.classList.remove("loading");
        input.select();
      }
    }

    root.querySelector("[data-submit]").addEventListener("click", submit);
    root.querySelector("[data-cancel]").addEventListener("click", close);
    root.querySelector("#admin-login-form").addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  }

  window.Admin = { getKey, isAdmin, login, logout, onUnauthorized, openLogin };
})();
