// views/login-view.js — sign in / sign up.
'use strict';

class LoginView extends View {
  constructor() {
    super('login');
    this._mode = 'login';
    this._error = null;
    this._busy = false;
  }

  onMount() {
    this.listen('user', (user) => {
      if (user && window.store.get('currentRoute')?.name === 'login') {
        window.router.go('trips', {}, { skipPush: true });
      }
    });
  }

  render() {
    const isLogin = this._mode === 'login';
    this.container.innerHTML = `
      <div class="auth-card sticker-card washi" style="padding:1.6rem;padding-top:1.9rem;">
        <div style="text-align:center;margin-bottom:1rem;">
          <img src="/assets/brand/travel-scrapbook-logo.svg" alt="" style="width:76px;height:76px;" />
          <h1 style="font-size:2.1rem;margin:0.3rem 0 0;">Travel Scrapbook</h1>
          <p class="scrap-card__sub">Save the links. We'll sort the trip.</p>
        </div>
        ${renderOAuthButtons({ busy: this._busy })}
        <form id="login-form">
          <label class="ts-label" for="login-email">Email</label>
          <input class="ts-input" id="login-email" type="email" autocomplete="email" required />
          <label class="ts-label" for="login-password">Password</label>
          <input class="ts-input" id="login-password" type="password" minlength="6" required
                 autocomplete="${isLogin ? 'current-password' : 'new-password'}" />
          ${this._error ? `<p class="auth-error">${escapeHtml(this._error)}</p>` : ''}
          <button class="ts-btn ts-btn--blush" type="submit" style="width:100%;margin-top:1rem;" ${this._busy ? 'disabled' : ''}>
            ${this._busy ? 'One sec…' : (isLogin ? 'Sign in' : 'Create account')}
          </button>
        </form>
        <p style="text-align:center;font-size:0.85rem;margin-top:1rem;">
          ${isLogin
            ? 'New here? <a href="#" id="login-switch" style="font-weight:800;">Create an account</a>'
            : 'Already have one? <a href="#" id="login-switch" style="font-weight:800;">Sign in</a>'}
        </p>
      </div>
    `;
    this.refreshIcons();

    this.container.querySelector('#login-switch').addEventListener('click', (ev) => {
      ev.preventDefault();
      this._mode = isLogin ? 'signup' : 'login';
      this._error = null;
      this.render();
    });

    this.container.querySelector('#login-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      this._busy = true;
      this._error = null;
      this.render();
      try {
        await handleEmailAuth(
          this._mode,
          this.container.querySelector('#login-email').value.trim(),
          this.container.querySelector('#login-password').value,
        );
        if (this._mode === 'signup') toast('Check your inbox to confirm your email');
      } catch (err) {
        this._error = err.message || 'Sign-in failed';
      } finally {
        this._busy = false;
        this.render();
      }
    });
  }
}
window.LoginView = LoginView;
