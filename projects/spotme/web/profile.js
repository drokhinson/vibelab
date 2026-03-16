// profile.js — SpotMe profile view

async function loadProfile() {
  const container = document.getElementById("profile-content");
  container.innerHTML = '<p aria-busy="true">Loading profile...</p>';

  try {
    currentUser = await apiFetch("/auth/me");
    renderProfile();
  } catch (err) {
    container.innerHTML = `<p class="error-text">${err.message}</p>`;
  }
}

function renderProfile() {
  const u = currentUser;
  if (!u) return;
  const container = document.getElementById("profile-content");

  const travelingHtml = u.traveling_to_label
    ? `<div class="profile-traveling">
        <span class="travel-icon">&#127970;</span>
        Traveling to <strong>${u.traveling_to_label}</strong>
        ${u.traveling_until ? `<span class="muted"> until ${new Date(u.traveling_until).toLocaleDateString()}</span>` : ""}
      </div>`
    : "";

  container.innerHTML = `
    <div class="profile-card">
      <div class="profile-header">
        <div class="profile-avatar">${u.display_name?.charAt(0)?.toUpperCase() || "?"}</div>
        <div class="profile-info">
          <h2>${u.display_name || u.username}</h2>
          <p class="muted">@${u.username}</p>
        </div>
      </div>
      ${u.bio ? `<p class="profile-bio">${u.bio}</p>` : '<p class="profile-bio muted">No bio yet</p>'}
      <div class="profile-location">
        <span class="location-icon">&#128205;</span>
        ${u.home_label || '<span class="muted">No home base set</span>'}
      </div>
      ${travelingHtml}
      <div class="profile-meta">
        <span class="badge ${u.is_discoverable ? 'badge-green' : 'badge-muted'}">${u.is_discoverable ? "Discoverable" : "Hidden"}</span>
        <span class="muted">Joined ${new Date(u.created_at).toLocaleDateString()}</span>
      </div>
      <button class="outline" onclick="showEditProfile()">Edit Profile</button>
    </div>

    <div id="edit-profile-section" style="display:none;">
      <h3>Edit Profile</h3>
      <form id="edit-profile-form" onsubmit="handleEditProfile(event)">
        <label for="edit-display-name">Display Name</label>
        <input type="text" id="edit-display-name" value="${u.display_name || ''}" required />
        <label for="edit-bio">Bio</label>
        <textarea id="edit-bio" rows="3" placeholder="Tell us about yourself...">${u.bio || ''}</textarea>
        <fieldset>
          <legend>Home Base</legend>
          <label for="edit-home-label">Location</label>
          <div class="location-input-row">
            <input type="text" id="edit-home-label" value="${u.home_label || ''}" placeholder="e.g. Denver, CO" />
            <button type="button" class="outline secondary" onclick="useMyLocation()">Use My Location</button>
          </div>
          <input type="hidden" id="edit-home-lat" value="${u.home_lat || ''}" />
          <input type="hidden" id="edit-home-lng" value="${u.home_lng || ''}" />
        </fieldset>
        <label>
          <input type="checkbox" id="edit-discoverable" ${u.is_discoverable ? 'checked' : ''} />
          Make me discoverable to nearby users
        </label>
        <div class="button-row">
          <button type="submit" id="save-profile-btn">Save</button>
          <button type="button" class="outline" onclick="cancelEditProfile()">Cancel</button>
        </div>
        <div id="edit-profile-error" class="error-banner" style="display:none;"></div>
      </form>
    </div>

    <div id="my-hobbies-summary">
      <h3>My Hobbies</h3>
      <div id="profile-hobbies-list"><p aria-busy="true">Loading...</p></div>
    </div>
  `;

  loadProfileHobbies();
}

async function loadProfileHobbies() {
  const container = document.getElementById("profile-hobbies-list");
  try {
    myHobbies = await apiFetch("/me/hobbies");
    if (!myHobbies.length) {
      container.innerHTML = '<p class="muted">No hobbies added yet. Go to the Hobbies tab to add some!</p>';
      return;
    }
    container.innerHTML = myHobbies.map(uh => {
      const hobby = uh.spotme_hobbies;
      const cat = hobby?.spotme_hobby_categories;
      return `
        <div class="hobby-tag">
          <span class="hobby-icon">${cat?.icon || '&#10024;'}</span>
          <span class="hobby-name">${hobby?.name || 'Unknown'}</span>
          <span class="hobby-peaks">${proficiencyPeaks(uh.proficiency)}</span>
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = `<p class="error-text">${err.message}</p>`;
  }
}

function showEditProfile() {
  document.getElementById("edit-profile-section").style.display = "block";
}

function cancelEditProfile() {
  document.getElementById("edit-profile-section").style.display = "none";
}

async function handleEditProfile(e) {
  e.preventDefault();
  const btn = document.getElementById("save-profile-btn");
  const errEl = document.getElementById("edit-profile-error");
  errEl.style.display = "none";
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;

  try {
    // Update profile
    await apiFetch("/profile", {
      method: "PUT",
      body: {
        display_name: document.getElementById("edit-display-name").value.trim(),
        bio: document.getElementById("edit-bio").value.trim(),
      },
    });

    // Update location
    const homeLabel = document.getElementById("edit-home-label").value.trim();
    const homeLat = parseFloat(document.getElementById("edit-home-lat").value) || null;
    const homeLng = parseFloat(document.getElementById("edit-home-lng").value) || null;
    await apiFetch("/profile/location", {
      method: "PUT",
      body: { home_label: homeLabel || null, home_lat: homeLat, home_lng: homeLng },
    });

    // Update discoverability
    const discoverable = document.getElementById("edit-discoverable").checked;
    await apiFetch("/profile/discoverable", {
      method: "PUT",
      body: { is_discoverable: discoverable },
    });

    document.getElementById("edit-profile-section").style.display = "none";
    loadProfile();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  } finally {
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
  }
}

function useMyLocation() {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported by your browser");
    return;
  }
  const btn = document.querySelector('[onclick="useMyLocation()"]');
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      document.getElementById("edit-home-lat").value = pos.coords.latitude;
      document.getElementById("edit-home-lng").value = pos.coords.longitude;
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
      // If no label set, add coords as placeholder
      const labelInput = document.getElementById("edit-home-label");
      if (!labelInput.value) {
        labelInput.value = `${pos.coords.latitude.toFixed(2)}, ${pos.coords.longitude.toFixed(2)}`;
      }
    },
    (err) => {
      alert("Could not get location: " + err.message);
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
    },
    { enableHighAccuracy: false, timeout: 10000 }
  );
}
