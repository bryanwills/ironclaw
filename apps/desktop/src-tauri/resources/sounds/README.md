# Notification sounds

This directory bundles short audio clips that the desktop notification
layer plays per category (chat reply / routine completion / sidecar
exit / error). The file names below are the contract the front-end
expects — if you change a name, also update the sound map in
`src/lib/stores/notifications.svelte.ts`.

## V1 status

No custom assets ship today. The front-end falls back to the macOS
system sounds at `/System/Library/Sounds/*.aiff` (Tink, Frog, Glass,
Pop, Submarine, Sosumi) plus the special `'default'` keyword which lets
the OS pick whatever is set in System Preferences → Sound. To unlock
custom sounds:

1. Drop the four files described below into this directory.
2. Uncomment the `resources/sounds/*` entry in `tauri.conf.json`'s
   `bundle.resources` array (one-line addition; see "Bundle wiring"
   below).
3. Update the symbolic → path map in
   `src/lib/stores/notifications.svelte.ts` to point at the bundled
   resources via `resolveResource()` instead of the
   `/System/Library/Sounds/*.aiff` paths.

## File contract

| File          | Used for           | Suggested feel             |
|---------------|--------------------|----------------------------|
| `chat.caf`    | Chat reply ping    | Short, bright, ~150 ms     |
| `routine.caf` | Routine completion | Two-note chime, ~400 ms    |
| `sidecar.caf` | Sidecar exit       | Soft warning blip, ~250 ms |
| `error.caf`   | Generic error      | Descending two-tone, ~400 ms |

All files must be:

- `.caf` (preferred, Apple Core Audio Format) or `.aiff` — these are
  what NSUserNotification's `soundName` field accepts on macOS.
- Mono, 16-bit, 44.1 kHz is plenty. Stereo works but wastes space.
- Under 1 second. Notification sounds should be tonally distinct but
  not draw the user's attention for longer than the banner does.
- Below -3 dBFS peak. Avoid clipping; the OS does not normalize.

To convert from MP3/WAV:

```sh
afconvert -f caff -d LEI16@44100 -c 1 input.wav chat.caf
```

(`afconvert` ships with macOS, no install needed.)

## Bundle wiring

Once real files exist here, add `"resources/sounds/*"` to
`src-tauri/tauri.conf.json` under `bundle.resources`. Tauri will copy
the directory into the `.app` bundle's `Resources/sounds/` folder, and
the runtime can resolve absolute paths via
`@tauri-apps/api/path::resolveResource('sounds/chat.caf')`.

Until then the directory is intentionally empty (this README aside) so
the bundle stays lean — adding the resources entry while the directory
is empty makes `cargo tauri build` warn about a missing glob match.
