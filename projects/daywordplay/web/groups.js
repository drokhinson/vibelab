'use strict';

// Modal visibility state — toggled from home.js (no-group prompt) and
// profile.js (My Groups). The modal renderers below are injected into the
// page-content innerHTML whenever the corresponding boolean is true.
let showCreateGroupModal = false;
let showJoinGroupModal = false;

function renderJoinModal() {
  return `
    <div class="modal-overlay" id="join-modal-overlay">
      <div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-title">Join by Code</div>
        <p class="text-muted" style="margin-bottom:16px;">Enter the 4-letter code shown on your friend's group leaderboard.</p>
        <div class="form-field">
          <label>Group Code</label>
          <input type="text" id="join-code-input" placeholder="ABCD" maxlength="4" style="text-transform:uppercase; font-family:monospace; font-size:20px; letter-spacing:4px; text-align:center;" />
        </div>
        <div id="join-error"></div>
        <button class="btn-primary full-width" id="join-code-submit" style="margin-top:8px;">Join Group</button>
        <button class="danger-btn" id="join-modal-close" style="margin-top:8px; color:var(--text-muted); border-color:var(--border);">Cancel</button>
      </div>
    </div>
  `;
}

function renderCreateModal() {
  return `
    <div class="modal-overlay" id="create-modal-overlay">
      <div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-title">Create a Group</div>
        <p class="text-muted" style="margin-bottom:16px;">Give your group a name. Share the 4-letter code so friends can join.</p>
        <div class="form-field">
          <label>Group Name</label>
          <input type="text" id="create-name-input" placeholder="e.g. Weekend Warriors" maxlength="40" />
        </div>
        <div id="create-error"></div>
        <button class="btn-primary full-width" id="create-group-submit" style="margin-top:8px;">Create Group</button>
        <button class="danger-btn" id="create-modal-close" style="margin-top:8px; color:var(--text-muted); border-color:var(--border);">Cancel</button>
      </div>
    </div>
  `;
}
