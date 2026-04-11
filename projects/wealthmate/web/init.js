// init.js — WealthMate event listeners and startup

document.addEventListener("DOMContentLoaded", async () => {
  // Auth forms
  document.getElementById("login-form").addEventListener("submit", handleLogin);
  document.getElementById("register-form").addEventListener("submit", handleRegister);
  document.getElementById("show-register").addEventListener("click", e => { e.preventDefault(); showView("register"); });
  document.getElementById("show-login").addEventListener("click", e => { e.preventDefault(); showView("login"); });

  // Bottom nav
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });

  // Dashboard
  document.getElementById("btn-new-checkin").addEventListener("click", startNewCheckin);
  document.getElementById("btn-continue-checkin").addEventListener("click", continueCheckin);

  // Check-in wizard
  document.getElementById("checkin-back").addEventListener("click", () => {
    if (checkinStep > 1) {
      setCheckinStep(checkinStep - 1);
      if (checkinStep === 2) renderCheckinAccounts();
    } else {
      showView("dashboard");
    }
  });
  document.getElementById("checkin-step1-next").addEventListener("click", checkinStep1Next);
  document.getElementById("checkin-step2-next").addEventListener("click", () => {
    setCheckinStep(3);
  });
  document.getElementById("checkin-step3-next").addEventListener("click", () => {
    setCheckinStep(4);
    renderCheckinReview();
  });
  document.getElementById("checkin-add-acct-btn").addEventListener("click", checkinStep3AddAccount);
  document.getElementById("checkin-submit").addEventListener("click", submitCheckin);

  // Accounts
  document.getElementById("btn-add-account").addEventListener("click", openAddAccount);
  document.getElementById("account-form").addEventListener("submit", handleAccountSubmit);
  document.getElementById("account-dialog-close").addEventListener("click", () => document.getElementById("account-dialog").close());
  document.getElementById("acct-close-btn").addEventListener("click", closeAccount);
  document.getElementById("acct-delete-btn").addEventListener("click", deleteAccountPermanently);
  document.getElementById("acct-category").addEventListener("change", onCategoryChange);

  // Expenses
  document.getElementById("btn-add-expense-group").addEventListener("click", () => document.getElementById("expense-group-dialog").showModal());
  document.getElementById("expense-group-dialog-close").addEventListener("click", () => document.getElementById("expense-group-dialog").close());
  document.getElementById("expense-group-form").addEventListener("submit", handleExpenseGroupSubmit);
  document.getElementById("expense-item-form").addEventListener("submit", handleExpenseItemSubmit);
  document.getElementById("expense-detail-back").addEventListener("click", backToExpenseGroups);

  // Monthly Bills
  document.getElementById("btn-add-bill").addEventListener("click", openAddBill);
  document.getElementById("bill-dialog-close").addEventListener("click", () => document.getElementById("bill-dialog").close());
  document.getElementById("bill-form").addEventListener("submit", handleBillSubmit);
  document.getElementById("bill-delete-btn").addEventListener("click", deleteBill);

  // Settings
  document.getElementById("invite-form").addEventListener("submit", handleInvite);
  document.getElementById("email-invite-form").addEventListener("submit", handleEmailInvite);
  document.getElementById("btn-logout").addEventListener("click", logout);
  document.getElementById("btn-delete-account").addEventListener("click", deleteAccount);

  // Data Management
  document.getElementById("btn-export-csv").addEventListener("click", handleExportCSV);
  document.getElementById("btn-download-template").addEventListener("click", handleDownloadTemplate);
  document.getElementById("btn-import-csv").addEventListener("click", handleImportCSV);
  document.getElementById("csv-import-file").addEventListener("change", () => {
    document.getElementById("btn-import-csv").disabled = !document.getElementById("csv-import-file").files.length;
  });

  // Theme toggle
  const themeToggle = document.getElementById("theme-toggle");
  const savedTheme = localStorage.getItem("wm_theme");
  if (savedTheme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
    themeToggle.checked = true;
  }
  themeToggle.addEventListener("change", () => {
    const theme = themeToggle.checked ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("wm_theme", theme);
  });

  // Init: check if logged in via Supabase session
  const loggedIn = await isLoggedIn();
  if (loggedIn) {
    try {
      currentUser = await apiFetch("/auth/me");
      showView("dashboard");
    } catch (e) {
      await sb.auth.signOut();
      showView("login");
    }
  } else {
    showView("login");
  }

  // React to Supabase auth state changes (e.g. session expiry)
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      currentUser = null;
      showView("login");
    }
  });

  // Init Lucide icons (for static HTML elements like nav, buttons)
  if (window.lucide) lucide.createIcons();
});
