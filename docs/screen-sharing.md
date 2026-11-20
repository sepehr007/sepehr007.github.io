# Screen sharing (Section 20)

Screen sharing is a peer-to-peer, browser-native feature of the watch room. It builds on the
existing mesh implementation in `assets/js/net.js` and `assets/js/room.js`; it was extended in
place, not rewritten.

## What the feature does

- **Share** the screen, a window, or a browser tab through the browser's own picker
  (`getDisplayMedia`). The site cannot and does not preselect a window or tab.
- **Shared audio where the browser/OS provides it.** The site asks for system audio first and
  falls back to video-only if the platform refuses. When a remote share has audio the viewer gets
  a sound button (mute/unmute) in the share bar.
- **Stop** from the site's share bar, from the browser's own "stop sharing" bar, or (for the
  host/manager) by sending a signed stop request to the sharer.
- **Status**: a live badge and the sharer's name are shown in the overlay; the share button shows
  active / ended states; viewers get a "peek" chip after hiding an overlay.
- **Participant controls**: manager force-stop (validated by the sharer), viewer hide/peek,
  viewer mute/unmute of shared audio, expand/restore of the overlay.
- **Responsive overlay**: the bar and its 32px touch targets fit a 390x844 phone viewport with no
  horizontal overflow (verified).
- **Late join / reconnect**: a viewer who enters while a share is running receives the active
  stream; failed screen peer connections are retried up to three times with backoff, and a
  network recovery re-syncs screen peers.

## Permission and error handling

| Condition | Result |
| --- | --- |
| User cancels the picker (`AbortError`) | Silent, no toast, no overlay |
| Permission denied (`NotAllowedError` / `PermissionDeniedError`) | Toast explaining how to allow it from the address bar |
| No picker available (`NotSupportedError`, or missing `getDisplayMedia`) | "This browser can't share a screen" |
| Capture busy / source gone (`NotReadableError`, `InvalidStateError`, `NotFoundError`) | Specific busy or missing-source toast |
| Insecure origin (`SecurityError`, non-secure context) | Explains that HTTPS or localhost is required |
| Remote autoplay blocked | Share still visible, audio marked blocked until the viewer taps the sound button |

## Signaling fix required by this section

Screen offers that include an audio track are ~6.5 KB. The public `ntfy.sh` relay accepts the POST
but silently drops payloads above its 4 KB message limit, so the viewer never saw the offer and
the sharer's UI showed no error. `Signal.send` now splits any payload over 3.8 KB into ordered
chunks (`{k:"chunk", id, i, n, d}`) and the receiving side reassembles it before dispatch. The
same path covers large voice offers and ICE payloads. Tested against a local relay that enforces
the same 4096-byte limit.

## Browser and OS limitations (honest list)

- **Chrome / Edge desktop** — screen, window, and tab selection. On Windows, "Entire screen"
  can include system audio; tab shares can include tab audio. Window shares never carry audio.
- **Firefox desktop** — screen or window selection; audio capture is limited and depends on the
  OS, so many shares are video-only.
- **Safari on macOS** — screen/window picker exists, but system audio capture is generally not
  available; shares are usually silent.
- **Chrome on Android** — `getDisplayMedia` is not supported on Android. The share button is
  dimmed by capability detection.
- **iOS / iPadOS (all browsers, WebKit)** — screen sharing is not supported.
- **Secure context required** — HTTPS (GitHub Pages) or localhost.
- **No SFU** — each viewer gets its own peer connection, so the sharer uploads one stream per
  viewer. Room capacity is 6; larger audiences are not supported and not claimed. LiveKit (or any
  external SFU) is deliberately not used.
- **Manager force-stop is a request**, signed by the host/manager and validated by the sharer. It
  cannot terminate a capture on a hostile or frozen client; the browser's own stop bar always
  remains authoritative.
- **No recording, no remote source switching, no audio mixing controls.**

## Test method and results

Automated with headless Chrome (CDP) — real `getDisplayMedia` capture with Chrome's
`--auto-select-desktop-capture-source=Entire screen` and fake UI, two or three isolated browser
profiles logged into real backend accounts, signaling through a local ntfy-compatible relay that
enforces the 4096-byte limit.

- `screen-share-p2p.mjs` — 25/25: host online, guest join, guest share reaching host, manager
  force-stop ending the guest's share, host share with audio reaching the guest (audio track
  present, sound button shown, mute/unmute), hide/peek, local stop, late viewer joining an active
  share, zero console errors and zero uncaught exceptions.
- `screen-extras.mjs` — 17/17: permission denial toast with no overlay, unsupported browser toast,
  share ended from the browser side cleaning up both sides, 390px mobile overlay with in-viewport
  touch targets.

What is **not** covered by automation: the real OS/browser picker UI, window/tab choices (the
picker is browser-owned), multi-monitor audio behavior, and physical Firefox/Safari/Android
devices. Those remain manual checks; the capability matrix in `docs/compatibility.md` keeps the
button dimmed where the API is missing.

## Files

- `assets/js/net.js` — chunked signaling, per-viewer screen peers, retry events, stop requests.
- `assets/js/room.js` — capture attempts, audio fallback, overlay state, viewer controls,
  manager force-stop, retry/backoff, late-join sync.
- `room.html`, `assets/css/style.css`, `assets/css/device-compat.css` — overlay, bar, 32px touch
  targets on coarse pointers.
- `assets/js/i18n.js` — fa/en strings for every state above.
