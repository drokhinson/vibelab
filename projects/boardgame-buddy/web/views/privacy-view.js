// views/privacy-view.js — the privacy policy.
//
// Every factual claim below was checked against the code rather than written
// from a template, because a policy that overclaims is worse than none. The
// load-bearing ones, with where to re-verify them if the behaviour changes:
//
//   "we never ask for your location"      domain/geo.js  — timezone, not the
//                                         geolocation permission, deliberately
//   "a photo's coordinate never leaves
//    your device"                         domain/geo-grid.js — countryAt() is
//                                         an array index into a local raster
//   "we strip the metadata"               helpers.js preparePhotoForUpload()
//                                         re-encodes via canvas, dropping EXIF
//   "photos are sent to Google" (import)  services/play_import_ai.py passes
//                                         images= to gemini.generate_json()
//   "anyone with the link can open it"    play_routes.py uses get_public_url()
//                                         on an unguessable uuid4 path
//   "we do not yet delete the file"       delete_play / delete_profile remove
//                                         rows only; no storage remove() exists
//   "usage counts are not linked to you"  _shared/001_analytics.sql has no user
//                                         column, and api.js sends no id
//
// KEEP THE LAST TWO HONEST. If storage cleanup lands, simplify §7; do not
// simplify it first. Same for the analytics row — the day an event carries a
// user id, §5 stops being true.

(function () {
  class PrivacyView extends window.LegalView {
    constructor() { super("privacy"); }

    _title() { return "Privacy Policy"; }
    _updated() { return "2026-09-18"; }

    _body() {
      return `
        <p>Boardgame Buddy records the games you play and who you played them
        with. This page says exactly what it stores, what leaves our servers,
        and how to get your data back or delete it.</p>

        <p>It is written to be specific rather than broad. Where something is
        imperfect, it says so.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">1. What we store</h2>

        <h3 class="font-semibold mt-4">Your account</h3>
        <p>Your email address, and — if you sign in with Google — the name and
        profile picture Google gives us. A display name and avatar you set
        yourself replace those.</p>

        <h3 class="font-semibold mt-4">What you log</h3>
        <p>Plays: the game, the date, who played, scores, your notes, and a
        two-letter country code (see §3). Your collection and wishlist. Your
        buddy connections. Reference-guide chapters you write, which are shared
        with other users when you publish them.</p>

        <h3 class="font-semibold mt-4">Photos</h3>
        <p>Photos you attach to a play. <strong>We remove the embedded metadata
        before storing them</strong> — the file is decoded and re-encoded on
        your device, which drops the capture time, the camera details and the
        GPS coordinate your phone may have written into it.</p>

        <h3 class="font-semibold mt-4">Optional connections</h3>
        <p>If you link a BoardGameGeek account, we store the username and an
        encrypted copy of the password. The encryption key lives only on the
        server, never in the app. We keep the password because BoardGameGeek has
        no API for this — the only way to read your collection is to log in as
        you, and sessions expire.</p>
        <p>If you turn on notifications, we store the push address your browser
        issues, the two keys that let us encrypt a message to it, and a label so
        you can tell your own devices apart.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">2. What we do not store</h2>
        <ul class="list-disc pl-5 space-y-1">
          <li>No advertising or cross-site tracking identifiers. There are no
              third-party analytics or advertising scripts in the app at all.</li>
          <li>No contact list, no calendar, no microphone.</li>
          <li>No payment details. If paid features arrive, a payment processor
              will handle card data and we will not see it.</li>
          <li>No coordinates. See below — this one is deliberate.</li>
        </ul>

        <h2 class="text-xl font-semibold mt-8 mb-2">3. Location, specifically</h2>
        <p><strong>The app never asks for your location permission.</strong> A
        play records at most which <em>country</em> it happened in, and that is
        worked out from your device's timezone setting — no permission, no
        network call, no third party.</p>
        <p>When you import photos from your camera roll, a photo may carry the
        exact coordinate where it was taken. <strong>That coordinate is turned
        into a country on your device and is never sent to us.</strong> The
        conversion is a lookup in a map of borders that ships inside the app.
        A GPS tag says where someone's home is; a country code cannot.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">4. Who else sees it</h2>
        <p>We do not sell your data and we do not share it for advertising.
        These are the companies that necessarily handle it so the app can run:</p>
        <ul class="list-disc pl-5 space-y-1">
          <li><strong>Supabase</strong> — the database and the photo storage.</li>
          <li><strong>Google Cloud</strong> — sign-in. Google sees that you
              authenticated and the email address on the account.</li>
          <li><strong>Railway</strong> — runs the server.</li>
          <li><strong>Cloudflare</strong> — serves the site and the images.</li>
          <li><strong>Google Gemini</strong> — the two AI features, and only
              when you use them. See §6.</li>
          <li><strong>BoardGameGeek</strong> — only if you link an account, and
              only to read or update your collection there.</li>
          <li><strong>Retailers</strong> — only if you tap a <em>Where to buy</em>
              link on a game's page. That opens the retailer's own site, under
              its own privacy policy; nothing about your account travels with
              the link. Some of those links are affiliate links — see the
              Terms.</li>
        </ul>

        <h3 class="font-semibold mt-4">Other people using the app</h3>
        <p>Your buddies see the plays you log and the photos attached to them.
        Reference-guide chapters you publish are visible to everyone.</p>

        <h3 class="font-semibold mt-4">A real limit on photo privacy</h3>
        <p>Play photos are stored at web addresses that are effectively
        impossible to guess, but they are <strong>not access-controlled</strong>:
        anyone who has the link can open the image without signing in. Treat a
        play photo as something you have shared with your table, not as a
        private file. Do not attach a photo you would not want forwarded.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">5. Usage counts</h2>
        <p>We record that an app-open happened, and how long the app took to
        start. <strong>Those records carry no account identifier, no IP address
        and no device identifier</strong> — the stored row is the app name, the
        event name and a timestamp, so it can tell us "the app was opened 400
        times yesterday" and can never tell us who opened it.</p>
        <p>A tap on a <em>Where to buy</em> link is counted the same way: which
        retailer, which game, which screen, and when — <strong>no account
        identifier</strong>. It tells us whether a retailer is worth listing,
        never who was shopping.</p>
        <p>Separately, the server logs the requests it makes to BoardGameGeek
        and to Google, so failures can be diagnosed. Those entries can include
        your BoardGameGeek username, because it is part of the request.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">6. The AI features</h2>
        <p>Two features send data to Google's Gemini API:</p>
        <ul class="list-disc pl-5 space-y-1">
          <li><strong>Reference-guide drafting</strong> — the game's name and
              description go to Google to draft a chapter, which you then
              edit.</li>
          <li><strong>Photo and note import</strong> — the photo or the text you
              are importing is sent to Google to be read into a play record.
              <strong>This means the photo itself leaves our servers.</strong></li>
        </ul>
        <p>Neither runs unless you start it. Google processes this as our API
        customer rather than for its own model training. AI output is often
        wrong about rules — see the Terms.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">7. Getting your data out, and deleting it</h2>
        <p><strong>Export.</strong> Settings has an export that produces a zip
        of spreadsheet files — your plays, collection, buddies and guides. It
        deliberately excludes your stored BoardGameGeek password.</p>
        <p><strong>Deletion.</strong> Settings has a delete-account control. It
        removes your profile and everything that hangs off it: plays, scores,
        collection, wishlist, buddy connections, achievements and push
        registrations. It also deletes the photos you uploaded and your
        sign-in itself, so the address you signed up with is free to use
        again. Guide chapters you published stay, with your name detached, so
        they do not vanish from other people's guides.</p>
        <p><strong>One gap, stated plainly:</strong> deleting a single
        <em>play</em> removes the record but does <em>not</em> yet delete the
        photo attached to it, which remains at its unguessable address until
        you delete your account. Deleting your account now removes every one
        of them. Until the per-play case is fixed, email us and we will remove
        an individual photo by hand.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">8. Storage on your device</h2>
        <p>The app keeps your sign-in session, your light/dark choice and some
        cached game data in your browser's own storage, and an offline copy of
        the app itself so it opens without a connection. None of that is an
        advertising cookie and none of it is readable by another site. Clearing
        your browser's site data removes all of it.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">9. How long we keep things</h2>
        <p>Your logs stay until you delete them or your account. Diagnostic
        request logs are pruned periodically.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">10. Children</h2>
        <p>The app is not directed at children under 13, and we do not knowingly
        create accounts for them. If you believe a child has an account, email
        us and we will remove it.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">11. Where your data lives</h2>
        <p>Our providers operate in the United States and the European Union, so
        your data may be processed in either. If you are in the EEA or the UK,
        you can ask for a copy of your data, its correction, or its deletion —
        the export and delete controls in Settings do the first and the last
        immediately, and email reaches us for anything else.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">12. Changes</h2>
        <p>If this policy changes in a way that affects what we collect or who
        receives it, we will say so in the app before the change takes effect
        rather than quietly moving the date at the top.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">13. Contact</h2>
        <p>Privacy questions, deletion requests and anything this page did not
        answer: <a class="link" href="mailto:privacy@bgbuddy.app">privacy@bgbuddy.app</a>.</p>`;
    }
  }

  window.PrivacyView = PrivacyView;
})();
