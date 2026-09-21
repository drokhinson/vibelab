// save-to-photos.js — hand a just-taken photo back to the user's camera roll.
//
// THE PLATFORM FACT, because it reads like a bug in this app and is not one:
// a photo taken through `<input type="file" accept="image/*">` → "Take Photo"
// on iOS is delivered to the page and NOWHERE else. WebKit never writes it to
// the Photos library, there is no attribute or capture mode that asks it to,
// and an installed PWA is no different from a Safari tab. The shot the user
// just framed exists only inside BoardgameBuddy until they save it themselves —
// so someone who logs a play, closes the app and goes looking for the photo in
// Photos finds nothing, and reasonably concludes the app lost it.
//
// Android is not affected: Chrome hands the capture off to the system camera
// app, which writes to the gallery on its own. Offering this there would only
// mint duplicates, which is why the affordance is gated on iOS rather than on
// "can this browser share files" alone.
//
// THE ONE FIX THE WEB HAS is `navigator.share({ files })`. The iOS share sheet's
// "Save Image" action writes to Photos, and it is the only route from a page to
// the camera roll — `<a download>` reaches Files, not Photos, and a canvas copy
// reaches neither. Two consequences shape this module:
//
//   1. IT MUST BE REACHED FROM A TAP. `share()` needs transient activation, and
//      the file input's `change` event does not carry it — that gesture was
//      already spent opening the camera. Hence a button on the preview rather
//      than an automatic prompt the moment a capture lands.
//   2. IT HANDS OVER THE USER'S OWN FILE, not the upload copy. helpers.js
//      downscales to 1920px and re-encodes at q=0.85 for the bucket; saving
//      *that* to Photos would quietly swap a 12MP original for a thumbnail of
//      itself. The prepared copy is only the fallback, for a source file the
//      platform refuses to share (an HEIC it will not take).
//
// Resolution of `share()` means iOS accepted the file, not that the user picked
// "Save Image" over Mail or Messages — so nothing here claims the photo was
// saved. The sheet is its own feedback; only failures speak.
(function () {
  "use strict";

  /**
   * iOS/iPadOS, including an installed PWA.
   *
   * Delegated to ui/install-prompt.js rather than re-derived: the
   * iPadOS-reports-as-a-Mac case is fiddly enough that two copies would drift,
   * and domain/push.js already leans on the same export for the same reason.
   * The inline copy is the fallback for a load order that has not reached
   * install-prompt.js yet — this module is only ever called from a render pass,
   * so in practice it never runs.
   */
  function _isIOS() {
    const ip = window.InstallPrompt;
    if (ip && typeof ip.isIOS === "function") return ip.isIOS();
    const ua = navigator.userAgent || "";
    return /iphone|ipad|ipod/i.test(ua)
      || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  }

  /**
   * Will this platform take this exact file through the share sheet?
   *
   * `canShare` is asked per file, not once per platform: iOS answers it on the
   * file's type, and an HEIC straight off the camera is the case that comes
   * back false while the JPEG beside it comes back true.
   *
   * @param {File|null|undefined} file
   * @returns {boolean}
   */
  function _shareable(file) {
    if (!file || typeof File !== "function" || !(file instanceof File)) return false;
    if (!navigator.share || !navigator.canShare) return false;
    try { return navigator.canShare({ files: [file] }); } catch (_) { return false; }
  }

  /**
   * The file to hand the OS — the user's own capture when it will be taken,
   * else the prepared upload copy, else nothing.
   *
   * @param {File|null} source    the file the picker handed over, untouched
   * @param {File|null} prepared  the compressed/re-encoded upload copy
   * @returns {File|null}
   */
  function _pick(source, prepared) {
    if (_shareable(source)) return source;
    if (_shareable(prepared)) return prepared;
    return null;
  }

  class SaveToPhotos {
    /**
     * Should a photo preview carry a "Save to Photos" control?
     *
     * Called at render time with whatever the draft is holding, so a preview of
     * an already-uploaded photo — no local file either side — is simply false.
     *
     * @param {File|null} source
     * @param {File|null} prepared
     * @returns {boolean}
     */
    offered(source, prepared) {
      return _isIOS() && !!_pick(source, prepared);
    }

    /**
     * Open the share sheet on the photo. Call from a tap handler — see the
     * activation note in this file's header.
     *
     * @param {File|null} source
     * @param {File|null} prepared
     * @returns {Promise<"shared"|"cancelled"|"unsupported"|"failed">}
     */
    async save(source, prepared) {
      const file = _pick(source, prepared);
      if (!file) {
        window.showToast("This browser can't pass a photo to Photos.", "error");
        return "unsupported";
      }
      try {
        await navigator.share({ files: [file] });
        return "shared";
      } catch (e) {
        // Backing out of the share sheet rejects with AbortError. That is a
        // decision, not a failure, and it gets no toast.
        if (e && e.name === "AbortError") return "cancelled";
        window.showToast("Couldn't open the share sheet.", "error");
        return "failed";
      }
    }
  }

  window.SaveToPhotos = new SaveToPhotos();
})();
