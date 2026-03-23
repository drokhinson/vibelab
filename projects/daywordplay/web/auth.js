'use strict';

function renderAuthScreen() {
  return `
    <div class="auth-screen">
      <div class="auth-logo">📖</div>
      <h1 class="auth-title">Day Word Play</h1>
      <p class="auth-subtitle">A new word every day. Your sentence. Your group's vote.</p>
      <div class="auth-card">
        <div class="auth-tabs">
          <button class="auth-tab active" id="tab-login">Log In</button>
          <button class="auth-tab" id="tab-register">Sign Up</button>
        </div>
        <div id="auth-form-wrap">
          ${renderLoginForm()}
        </div>
      </div>
    </div>
  `;
}

function renderLoginForm(error = '') {
  return `
    ${error ? renderError(error) : ''}
    <form id="login-form">
      <div class="form-field">
        <label for="login-username">Username</label>
        <input type="text" id="login-username" placeholder="your username" autocomplete="username" required />
      </div>
      <div class="form-field">
        <label for="login-password">Password</label>
        <input type="password" id="login-password" placeholder="••••••" autocomplete="current-password" required />
      </div>
      <button type="submit" class="auth-submit" id="login-submit">Log In</button>
    </form>
  `;
}

function renderRegisterForm(error = '') {
  return `
    ${error ? renderError(error) : ''}
    <form id="register-form">
      <div class="form-field">
        <label for="reg-username">Username</label>
        <input type="text" id="reg-username" placeholder="choose a username" autocomplete="username" required />
      </div>
      <div class="form-field">
        <label for="reg-display">Display Name</label>
        <input type="text" id="reg-display" placeholder="your name (optional)" />
      </div>
      <div class="form-field">
        <label for="reg-password">Password</label>
        <input type="password" id="reg-password" placeholder="at least 6 characters" autocomplete="new-password" required />
      </div>
      <button type="submit" class="auth-submit" id="reg-submit">Create Account</button>
    </form>
  `;
}

function initAuthListeners() {
  document.getElementById('tab-login')?.addEventListener('click', () => {
    document.getElementById('tab-login').classList.add('active');
    document.getElementById('tab-register').classList.remove('active');
    document.getElementById('auth-form-wrap').innerHTML = renderLoginForm();
    attachLoginListener();
  });

  document.getElementById('tab-register')?.addEventListener('click', () => {
    document.getElementById('tab-register').classList.add('active');
    document.getElementById('tab-login').classList.remove('active');
    document.getElementById('auth-form-wrap').innerHTML = renderRegisterForm();
    attachRegisterListener();
  });

  attachLoginListener();
}

function attachLoginListener() {
  document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('login-submit');
    btn.disabled = true;
    btn.textContent = 'Logging in…';
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    try {
      const data = await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setToken(data.token);
      currentUser = data.user;
      localStorage.setItem('dwp_user', JSON.stringify(data.user));
      await loadEagerData();
      renderApp();
      initShellListeners();
      initPageListeners();
      _loadDeferredData();
    } catch (err) {
      document.getElementById('auth-form-wrap').innerHTML = renderLoginForm(err.message);
      attachLoginListener();
    }
  });
}

function attachRegisterListener() {
  document.getElementById('register-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('reg-submit');
    btn.disabled = true;
    btn.textContent = 'Creating account…';
    const username = document.getElementById('reg-username').value.trim();
    const display_name = document.getElementById('reg-display').value.trim();
    const password = document.getElementById('reg-password').value;
    try {
      const data = await apiFetch('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, password, display_name: display_name || undefined }),
      });
      setToken(data.token);
      currentUser = data.user;
      localStorage.setItem('dwp_user', JSON.stringify(data.user));
      await loadEagerData();
      renderApp();
      initShellListeners();
      initPageListeners();
      _loadDeferredData();
    } catch (err) {
      document.getElementById('auth-form-wrap').innerHTML = renderRegisterForm(err.message);
      attachRegisterListener();
    }
  });
}
