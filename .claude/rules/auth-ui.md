---
paths:
  - "projects/*/web/auth.js"
  - "projects/*/web/styles.css"
---

# Auth UI Standard — OAuth Buttons & Email Divider

Every web auth screen that offers Google / Apple sign-in uses the same visuals so the auth surface feels consistent across the monorepo. The canonical reference is daywordplay (`projects/daywordplay/web/auth.js:96-122` + `projects/daywordplay/web/styles.css:960-1001`). Copy these snippets verbatim when adding a new auth screen, or when `/ui-polish` migrates an old one.

## Pattern

- **Provider logos are inline SVG**, not Lucide / image / emoji. Google uses the four-color `G` (4 `<path>` elements with their official hex fills). Apple uses a single `<path>` with `fill="currentColor"` so it inherits the button text color (light on dark, dark on light).
- Logos are **18×18px**, sized via `.auth-oauth-logo`.
- Buttons are **full-width pills** (`border-radius: 999px`, `width: 100%`).
- Two variant classes: `.auth-oauth-google` and `.auth-oauth-apple`. The Apple variant rebinds `color` on `.auth-oauth-logo` so the monochrome glyph adopts the button's text color.
- Below the OAuth buttons, a **hairline divider** with the copy "or use email" separates social sign-in from the email form.
- Buttons are stacked: Google first, Apple second, then the divider, then the email form.

## Canonical markup

```html
<button type="button" class="auth-oauth-btn auth-oauth-google" id="oauth-google-btn">
  <svg class="auth-oauth-logo" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
  <span>Continue with Google</span>
</button>

<button type="button" class="auth-oauth-btn auth-oauth-apple" id="oauth-apple-btn">
  <svg class="auth-oauth-logo" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.351 2.18-.117.073-2.617 1.51-2.617 4.5 0 3.43 3.083 4.65 3.213 4.69z"/>
  </svg>
  <span>Continue with Apple</span>
</button>

<div class="auth-divider"><span>or use email</span></div>
```

## Canonical CSS

The CSS uses `var(--bg)`, `var(--bg-card)`, `var(--text-primary)`, `var(--text-muted)`, `var(--border)` — define these in your project's stylesheet to match its palette. If your project doesn't have CSS custom properties, substitute literal colors that fit the theme.

```css
/* OAuth provider buttons (Google / Apple) */
.auth-oauth-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  background: var(--bg);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 11px 16px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  margin-bottom: 10px;
  transition: background 0.15s, border-color 0.15s, transform 0.1s;
}
.auth-oauth-btn:hover:not(:disabled) {
  background: var(--bg-card);
  border-color: var(--text-muted);
}
.auth-oauth-btn:active:not(:disabled) { transform: translateY(1px); }
.auth-oauth-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.auth-oauth-logo { width: 18px; height: 18px; flex-shrink: 0; }
.auth-oauth-apple .auth-oauth-logo { color: var(--text-primary); }

.auth-divider {
  display: flex;
  align-items: center;
  text-align: center;
  margin: 18px 0 16px;
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 400;
}
.auth-divider::before,
.auth-divider::after {
  content: "";
  flex: 1;
  border-top: 1px solid var(--border);
}
.auth-divider span { padding: 0 12px; }
```

## Anti-patterns

These exist on the branch today (sauceboss, boardgame-buddy) and should be migrated to the canonical pattern whenever those auth screens are next touched:

- ❌ Text-only OAuth buttons (no logo). Sauceboss does this.
- ❌ Lucide icons (`<i data-lucide="chrome">`, `<i data-lucide="apple">`) instead of inline SVG. Boardgame-buddy does this. Lucide's `chrome` is not the Google brand mark, and Lucide's `apple` is a fruit, not the logo.
- ❌ Emoji (🍎, etc.) for provider marks. Looks unprofessional and renders inconsistently.
- ❌ Squared / lightly-rounded buttons. Use the full pill (`border-radius: 999px`).
- ❌ Divider copy other than "or use email". Keep it consistent across apps.
