// about-profile.js — profile block on the person page (about.html).
// Hydrates the name/role/bio from the person API (static HTML is the fallback)
// and, in admin edit mode, exposes a pencil that opens a text editor. Photo
// editing is out of scope for now (see person_profile.photo_path).
(function () {
  "use strict";

  var PA = window.PersonAdmin;
  var nameEl = document.getElementById("profile-name");
  var roleEl = document.getElementById("profile-role");
  var bioEl = document.getElementById("profile-bio");
  var editBtn = document.getElementById("profile-edit-btn");

  // Last-known profile values, seeded from the static HTML so the editor opens
  // with sensible defaults even before the backend responds.
  var profile = {
    name: nameEl ? nameEl.textContent.trim() : "",
    role: roleEl ? roleEl.textContent.trim() : "",
    bio: bioEl ? bioEl.textContent.trim() : "",
  };

  var PROFILE_FIELDS = [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "role", label: "Role", type: "text" },
    { name: "bio", label: "Bio", type: "textarea", rows: 4 },
  ];

  // ── Rendering ─────────────────────────────────────────────────────────────
  function render() {
    if (nameEl) nameEl.textContent = profile.name || "";
    if (roleEl) roleEl.textContent = profile.role || "";
    if (bioEl) bioEl.textContent = profile.bio || "";
  }

  function renderEditBtn() {
    if (editBtn) editBtn.hidden = !PA.isAdmin();
  }

  // ── Admin action ──────────────────────────────────────────────────────────
  async function onEditProfile() {
    var vals = await PA.formModal({
      title: "Edit profile",
      submitLabel: "Save",
      fields: PROFILE_FIELDS,
      values: profile,
    });
    if (!vals) return;
    try {
      var updated = await PA.adminFetch("/admin/profile", {
        method: "PUT",
        body: JSON.stringify(vals),
      });
      profile = {
        name: updated.name || "",
        role: updated.role || "",
        bio: updated.bio || "",
      };
      render();
    } catch (err) {
      window.alert("Could not save profile: " + err.message);
    }
  }

  // ── Load ──────────────────────────────────────────────────────────────────
  async function loadProfile() {
    var fetched;
    try {
      fetched = await PA.publicFetch("/profile");
    } catch (err) {
      // Backend unreachable — keep the static HTML as-is (progressive
      // enhancement), mirroring how the travel grid stays dormant.
      console.warn("Profile: unavailable, using static content.", err);
      return;
    }
    profile = {
      name: fetched.name || profile.name,
      role: fetched.role || profile.role,
      bio: fetched.bio || profile.bio,
    };
    render();
  }

  if (editBtn) editBtn.addEventListener("click", onEditProfile);
  PA.onChange(renderEditBtn);
  renderEditBtn();

  document.addEventListener("DOMContentLoaded", loadProfile);
})();
