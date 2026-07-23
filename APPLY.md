# A11y Lens — remembered form-filling profile + no stray pointer movement

`node --check` + `tsc -b` + `vite build` clean. 17 suites pass, including
no-regression. Profile routes verified against a live sidecar.

## Files
    sidecar/server.mjs               (profile persistence, stripSecrets, 2 routes)
    sidecar/interact.mjs             (parkMouse after every interaction)
    sidecar/element-shots.mjs        (park the pointer before every screenshot)
    scripts/test-profile-pointer.mjs (NEW)

## 1 · Form filling is now remembered
`valueProfile` was accepted per request and never stored, so the Operate gear's
test values had to be retyped before every run. That friction is why form testing
gets skipped — and forms are where the worst accessibility defects live.

Now: a profile sent with a run WINS and is saved; if none is sent, the last saved
one is reused. Two routes to manage it:

    GET    /settings/value-profile     read back what is remembered
    DELETE /settings/value-profile     forget it entirely

**What is deliberately NOT remembered:** anything credential-shaped. Field names
matching password / passcode / pwd / secret / token / otp / pin / cvv / cvc / ssn /
cpr / card number / iban / apiKey are stripped before saving, at any nesting depth.
Ordinary test data (name, email, phone, postcode, address) is kept. A tool that
quietly persisted a password to disk would be a liability no matter how convenient.

## 2 · No stray pointer movement
First, the thing that is NOT happening: Playwright drives a pointer INSIDE the
browser. It never moves the operating system cursor, so your real mouse is never
touched and nothing can wander across your screen.

The genuine problem was subtler. `locator.click()` moves that virtual pointer onto
the target and LEAVES it there, which meant:

  * the clicked control (and its ancestors) stayed in `:hover`, so a hover-reveal
    menu could remain open and bleed into the NEXT state scanned — findings then
    attributed to the wrong screen;
  * hover-driven analytics and tooltip timers kept firing on a control the tool
    touched, which is activity the user never performed;
  * screenshots caught elements in their hover state — a highlight the real user
    never triggered, and sometimes a tooltip covering the very element the red
    callout points at.

The pointer is now parked at (0,0) after opening a state, after reversing one, and
before every capture. Parking is best-effort and never throws, so a page without a
pointer API cannot break a scan.

The one intentional hover remains: `replay.mjs` hovers to open hover-reveal menus,
because that is the interaction being tested rather than an accident.
