// hobbies.js — SpotMe hobbies browser + user hobby management

async function loadHobbies() {
  const container = document.getElementById("hobbies-content");
  container.innerHTML = '<p aria-busy="true">Loading hobbies...</p>';

  try {
    // Load categories and hobbies in parallel
    const [cats, hobbies, userHobbies] = await Promise.all([
      apiFetch("/hobbies/categories"),
      apiFetch("/hobbies"),
      apiFetch("/me/hobbies"),
    ]);
    hobbyCategories = cats;
    allHobbies = hobbies;
    myHobbies = userHobbies;
    renderHobbies();
  } catch (err) {
    container.innerHTML = `<p class="error-text">${err.message}</p>`;
  }
}

function renderHobbies() {
  const container = document.getElementById("hobbies-content");

  // Build my hobbies set for quick lookup
  const myHobbyIds = new Set(myHobbies.map(uh => uh.hobby_id));

  // Category filter tabs
  const filterHtml = `
    <div class="category-filters">
      <button class="filter-btn ${!selectedCategoryFilter ? 'active' : ''}" onclick="filterCategory(null)">All</button>
      ${hobbyCategories.map(c => `
        <button class="filter-btn ${selectedCategoryFilter === c.id ? 'active' : ''}" onclick="filterCategory('${c.id}')">
          ${c.icon} ${c.name}
        </button>
      `).join('')}
    </div>
  `;

  // My hobbies section
  const myHobbiesHtml = myHobbies.length ? `
    <div class="my-hobbies-section">
      <h3>My Hobbies</h3>
      <div class="hobby-grid">
        ${myHobbies.map(uh => {
          const hobby = uh.spotme_hobbies;
          const cat = hobby?.spotme_hobby_categories;
          return `
            <div class="hobby-card my-hobby" data-category="${cat?.slug || ''}">
              <div class="hobby-card-header">
                <span class="hobby-icon">${cat?.icon || '&#10024;'}</span>
                <span class="hobby-name">${hobby?.name || 'Unknown'}</span>
              </div>
              <div class="hobby-card-body">
                <div class="hobby-peaks">${proficiencyPeaks(uh.proficiency)}</div>
                <span class="proficiency-label">${proficiencyLabel(uh.proficiency)}</span>
                ${uh.notes ? `<p class="hobby-notes">${uh.notes}</p>` : ''}
              </div>
              <div class="hobby-card-actions">
                <button class="outline small" onclick="editMyHobby('${uh.id}', '${uh.proficiency}', '${(uh.notes || '').replace(/'/g, "\\'")}')">Edit</button>
                <button class="outline small danger" onclick="removeMyHobby('${uh.id}')">Remove</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  ` : '';

  // Browse hobbies section
  const filteredHobbies = selectedCategoryFilter
    ? allHobbies.filter(h => h.category_id === selectedCategoryFilter)
    : allHobbies;

  const browseHtml = `
    <div class="browse-hobbies-section">
      <h3>Browse Hobbies</h3>
      <div class="hobby-grid">
        ${filteredHobbies.map(h => {
          const cat = h.spotme_hobby_categories;
          const isAdded = myHobbyIds.has(h.id);
          return `
            <div class="hobby-card browse-hobby ${isAdded ? 'added' : ''}" data-category="${cat?.slug || ''}">
              <div class="hobby-card-header">
                <span class="hobby-icon">${cat?.icon || '&#10024;'}</span>
                <span class="hobby-name">${h.name}</span>
              </div>
              <div class="hobby-card-body">
                <span class="category-label">${cat?.name || ''}</span>
              </div>
              <div class="hobby-card-actions">
                ${isAdded
                  ? '<span class="badge badge-green">Added</span>'
                  : `<button class="small" onclick="openAddHobby('${h.id}', '${h.name}')">+ Add</button>`
                }
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  container.innerHTML = filterHtml + myHobbiesHtml + browseHtml;
}

function filterCategory(categoryId) {
  selectedCategoryFilter = categoryId;
  renderHobbies();
}

// ── Add hobby dialog ─────────────────────────────────────────────────────────
function openAddHobby(hobbyId, hobbyName) {
  document.getElementById("add-hobby-name").textContent = hobbyName;
  document.getElementById("add-hobby-id").value = hobbyId;
  document.getElementById("add-hobby-proficiency").value = "beginner";
  document.getElementById("add-hobby-notes").value = "";
  document.getElementById("add-hobby-error").style.display = "none";
  document.getElementById("add-hobby-dialog").showModal();
}

async function handleAddHobby(e) {
  e.preventDefault();
  const btn = document.getElementById("add-hobby-btn");
  const errEl = document.getElementById("add-hobby-error");
  errEl.style.display = "none";
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;

  try {
    await apiFetch("/me/hobbies", {
      method: "POST",
      body: {
        hobby_id: document.getElementById("add-hobby-id").value,
        proficiency: document.getElementById("add-hobby-proficiency").value,
        notes: document.getElementById("add-hobby-notes").value.trim() || null,
      },
    });
    document.getElementById("add-hobby-dialog").close();
    loadHobbies();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  } finally {
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
  }
}

// ── Edit hobby dialog ────────────────────────────────────────────────────────
function editMyHobby(userHobbyId, proficiency, notes) {
  document.getElementById("edit-hobby-id").value = userHobbyId;
  document.getElementById("edit-hobby-proficiency").value = proficiency;
  document.getElementById("edit-hobby-notes").value = notes;
  document.getElementById("edit-hobby-error").style.display = "none";
  document.getElementById("edit-hobby-dialog").showModal();
}

async function handleEditHobby(e) {
  e.preventDefault();
  const btn = document.getElementById("edit-hobby-btn");
  const errEl = document.getElementById("edit-hobby-error");
  errEl.style.display = "none";
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;

  try {
    const id = document.getElementById("edit-hobby-id").value;
    await apiFetch(`/me/hobbies/${id}`, {
      method: "PUT",
      body: {
        proficiency: document.getElementById("edit-hobby-proficiency").value,
        notes: document.getElementById("edit-hobby-notes").value.trim() || null,
      },
    });
    document.getElementById("edit-hobby-dialog").close();
    loadHobbies();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  } finally {
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
  }
}

async function removeMyHobby(userHobbyId) {
  if (!confirm("Remove this hobby from your profile?")) return;
  try {
    await apiFetch(`/me/hobbies/${userHobbyId}`, { method: "DELETE" });
    loadHobbies();
  } catch (err) {
    alert(err.message);
  }
}
