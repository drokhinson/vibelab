// views/terms-view.js — the terms of service.
//
// One thing here cannot be derived from the code and has to be set by a human:
// JURISDICTION below. It is left empty on purpose and the page renders a loud
// banner in its place, so an unset value is visible to the first person who
// opens the page rather than shipping as a governing-law clause that names
// nowhere. Set it to the state or country whose law applies and the banner goes
// away.
//
// The content claims that overlap the privacy policy are deliberately worded to
// match it — the published-chapter licence in §4 mirrors "guide chapters you
// published stay, with your name detached" in Privacy §7, and the photo-link
// warning in §9 mirrors Privacy §4. If one moves, move both.
//
// This is a plain-language draft written against how the app actually behaves.
// It is not legal advice, and it has not been reviewed by a lawyer.

(function () {
  // e.g. "the State of New York, USA" or "England and Wales".
  const JURISDICTION = "";

  class TermsView extends window.LegalView {
    constructor() { super("terms"); }

    _title() { return "Terms of Service"; }
    _updated() { return "2026-09-15"; }

    _governingLaw() {
      if (!JURISDICTION) {
        return `
          <p class="alert alert-warning text-sm" role="alert">
            <strong>Unpublished:</strong> the governing-law jurisdiction has not
            been set. Set <code>JURISDICTION</code> in
            <code>views/terms-view.js</code> before relying on this page.
          </p>`;
      }
      return `<p>These terms are governed by the laws of ${JURISDICTION}, and any
              dispute will be handled by the courts there.</p>`;
    }

    _body() {
      return `
        <p>These terms cover your use of Boardgame Buddy at bgbuddy.app. Using
        the app means you accept them. They are written to be read, not to be
        skipped.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">1. What this is</h2>
        <p>Boardgame Buddy is a personal log for board game plays, with a
        collection tracker, shared reference guides, and a live scoring screen.
        It is free to use and it is early software — features change, and some
        of them break.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">2. Your account</h2>
        <p>You need an account to log anything. Keep your sign-in secure; you
        are responsible for what happens under your account. Tell us if you
        think someone else has access to it.</p>
        <p>One account per person. Do not create accounts for other people
        without their knowledge — if you want to record a play with someone who
        has not signed up, the app has placeholder players for exactly that.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">3. What you can do here</h2>
        <p>Use the app for its purpose. Specifically, do not:</p>
        <ul class="list-disc pl-5 space-y-1">
          <li>upload photos of other people without their agreement, or anything
              illegal, harassing or sexual;</li>
          <li>try to reach another user's data, or test the app's security
              boundaries without asking us first;</li>
          <li>automate the app to make requests at a rate a person could not, or
              use it as a general-purpose scraper for board game data;</li>
          <li>impersonate someone else, including in a display name.</li>
        </ul>
        <p>We can remove content or close an account that does these things.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">4. Your content stays yours</h2>
        <p>Your plays, notes and photos are yours. You give us permission to
        store them and to show them to the people you share them with — your
        buddies, and anyone viewing a session you are hosting. That permission
        exists so the app can function, and it ends when you delete the content
        or your account.</p>
        <p><strong>Published reference-guide chapters are different.</strong> A
        chapter you publish becomes part of other users' guides, so it stays
        available after you delete your account — with your name detached from
        it. If you do not want that, keep the chapter private.</p>
        <p>You confirm you have the right to upload what you upload.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">5. BoardGameGeek</h2>
        <p>Linking a BoardGameGeek account is optional. When you link one, the
        app acts as you on that site — reading your collection and, if you ask
        it to, updating it. <strong>You remain responsible for complying with
        BoardGameGeek's own terms</strong>, and we are not affiliated with or
        endorsed by them.</p>
        <p>Game titles, descriptions and cover images come from BoardGameGeek
        and from publishers. Those remain the property of their owners; nothing
        here transfers any right to them.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">6. The AI features are not a rulebook</h2>
        <p>Reference-guide chapters can be drafted by an AI model, and the photo
        importer uses one to read a play off an image. <strong>Both are
        regularly wrong.</strong> A generated chapter is a starting point for you
        to correct, not an authority — do not settle a rules argument with it,
        and check an imported play before you trust its scores.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">7. Availability</h2>
        <p>There is no uptime promise. The app runs on free and low-cost
        infrastructure, and we may change it, take features away, or stop
        running it entirely. If we shut it down, we will give notice and time to
        export your data.</p>
        <p>If paid features arrive, we will say what is paid before charging
        anything, and what you have logged will stay readable and exportable
        whether or not you pay.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">8. Ending it</h2>
        <p>Delete your account in Settings whenever you like. We may suspend or
        close an account that breaks §3, or if we stop running the service.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">9. Photos are shareable by link</h2>
        <p>Photos you attach are stored at addresses that cannot realistically
        be guessed, but anyone who has the link can open the image without
        signing in. Treat a play photo as shared with your table. This is also
        in the <a class="link" href="/privacy" onclick="window.router.go('privacy'); return false;">Privacy Policy</a>,
        which forms part of these terms.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">10. No warranty</h2>
        <p>The app is provided as it is, without warranties of any kind. We do
        not promise it will be available, error-free, or that it will not lose
        data. Export anything you would be upset to lose.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">11. Limits on liability</h2>
        <p>To the fullest extent the law allows, we are not liable for indirect
        or consequential losses, or for lost data or lost profits, arising from
        your use of the app. Nothing here limits liability that cannot be
        limited by law.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">12. Changes</h2>
        <p>We may update these terms. If a change matters — anything affecting
        your content, your data, or what you are allowed to do — we will say so
        in the app before it takes effect rather than only changing the date at
        the top.</p>

        <h2 class="text-xl font-semibold mt-8 mb-2">13. Governing law</h2>
        ${this._governingLaw()}

        <h2 class="text-xl font-semibold mt-8 mb-2">14. Contact</h2>
        <p><a class="link" href="mailto:support@bgbuddy.app">support@bgbuddy.app</a>.</p>`;
    }
  }

  window.TermsView = TermsView;
})();
