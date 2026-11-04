# Developing Valence

The technical side of Valence: how the library is laid out on disk, how devices stay in sync, and
how to build, test and package it. For what the app does, see the [README](../README.md). The
morning-after checklist from the first build is in [MORNING.md](../MORNING.md); the Android app has
its own notes in [android/](../android/).

## Running from source

Requires Node 24.

```bash
npm ci
npm run fetch-binaries   # fpcalc for this platform (ffmpeg comes from ffmpeg-static)
npm run dev              # electron-vite dev server
npm test                 # vitest: unit + integration (generated audio, fixtures, sandbox library)
npm run typecheck
```

End-to-end scripts (run from PowerShell on Windows):

```bash
node scripts/e2e-ui.mjs         # every view, playback, lyrics, mini player → test-results/ui/
node scripts/e2e-playback.mjs   # gapless continuity, seek accuracy, SMTC registration
npm run smoke                   # native modules + binaries load inside Electron
node scripts/smoke-packaged.mjs # after dist:win: packaged exe imports + plays in a sandbox, opens ~/Music
node scripts/real-import.mjs <folder>...   # import real folders into ~/Music, summary → test-results/
```

Useful environment overrides:

| Variable | Effect |
|---|---|
| `VALENCE_LIBRARY_ROOT` | Library folder instead of `~/Music` |
| `VALENCE_DATA_DIR` | App data (database, caches, tokens) |
| `VALENCE_ARCHIVE_DIR` | Lossless archive, overriding the setting |
| `VALENCE_INBOX` | Inbox folder instead of `~/Valence Inbox` |
| `VALENCE_MUTE=1` | Engine renders silence (tests) |
| `VALENCE_NO_MICA=1` | Opaque window instead of Mica on Windows 11 |

Icons are Material Icons Rounded (the Android app's glyphs). To add one, map it in
`scripts/gen-icons.mjs` and run `node scripts/gen-icons.mjs` to regenerate
`src/renderer/components/icons.generated.ts`.

## Packaging

```bash
npm run dist:win     # NSIS installer + portable exe → release/
npm run dist:mac     # arm64 dmg (run on the Mac; ad-hoc signed, no Developer ID)
npm run dist:linux   # AppImage, rpm, pacman (run on Linux)
```

### CI builds

`.github/workflows/build.yml` builds everything on GitHub Actions: the Windows setup `.exe` and
`.msi`, `Valence.app` zipped for Apple Silicon and Intel, a Linux AppImage, and Android APKs for ARM
and x86. Start it from the Actions tab (**Build → Run workflow**; **Only** limits it to one
platform), or push a version tag (`git tag v0.2.0 && git push origin v0.2.0`), which builds
everything and collects the files into a draft release. Each run's files are under **Artifacts** on
its summary page. The repo is private, so runs use the account's Actions minutes (macOS counts 10×,
Windows 2×); building only what you need saves a lot.

- Each platform builds on its own runner, because the native modules (better-sqlite3, sharp,
  ffmpeg-static) install for the machine doing the build.
- **macOS:** one job on GitHub's Intel runner (`macos-15-intel`) builds both apps, so a run needs a
  single Mac runner. GitHub's Apple Silicon runners never picked our jobs up (capacity), and in US
  daytime even Intel ones can take 10+ minutes or drop a job after 15. The job packages the Intel
  app, reinstalls the native packages for arm64, packages the Apple Silicon app, and checks each with
  `scripts/ci-mac-check.sh` (signature, and every binary for the right CPU). `macos-15-intel` is
  GitHub's last Intel image; when it retires, swap the roles (build on Apple Silicon, cross-build
  Intel).
- The app is ad-hoc signed, not notarized. Apple Silicon needs at least that to launch it. The first
  time, right-click it and choose **Open**, or run `xattr -dr com.apple.quarantine Valence.app`.
- **Android:** `-Pabis=…` limits an APK to one CPU family; local builds stay universal. Release APKs
  are signed with the debug key. So that CI's APKs install over the copy already on your phone, the
  repository secret `ANDROID_DEBUG_KEYSTORE` holds this PC's debug keystore:

  ```bash
  base64 -w0 ~/.android/debug.keystore | gh secret set ANDROID_DEBUG_KEYSTORE
  ```

  Without it, each run signs with a throwaway key, and Android won't install that over an existing
  copy.
- Build artifacts are kept for 7 days; releases keep their own copies.

### Nightly releases

`.github/workflows/nightly.yml` runs at 10:17 UTC every night. If master has commits since the last
nightly, it runs `build.yml` with a version like `0.1.0-nightly.20261105` and publishes the
packages as the **Nightly** pre-release (tag `nightly`), replacing the previous one. The notes list
the commits since the last nightly. Nights with nothing new end after a few seconds. Run it by hand
(**Nightly → Run workflow**) to publish straight away, even without new commits.

- **Versions:** the app and the file names carry the nightly version. Windows installers need a
  numeric version, so they get `0.1.0.<run number>`, and each nightly MSI upgrades the last. On
  Android only the version name changes; the version code stays put, so nightlies and your own
  builds install over each other.
- **A platform that didn't build** (most often a Mac runner GitHub couldn't supply) doesn't hold up
  the rest: its files carry over from the previous Nightly, the notes say which, and the run shows as
  failed. If nothing built, the previous Nightly stays as it was.
- **Cost:** a full nightly uses roughly 200 of the account's Actions minutes (the Macs count 10×).
  To build less, set the repository variable `NIGHTLY_PLATFORMS` (Settings → Secrets and variables
  → Actions → Variables) to a list such as `windows,linux,android`.
- After publishing, the run deletes its own artifacts, since the release holds the files.

## The library on disk

- **Layout:** `Album Artist/Album (Year)/Title.mp3`, with no track numbers in filenames (they live in
  the tags). Singles get their own folder, collaborations go under the primary artist, and
  compilations go under `Various Artists/`.
- **Lossless sources:** transcoded to MP3 320 CBR for the library. The FLAC master goes to an archive
  folder you choose, which isn't synced and can be on another drive (exFAT/FAT32 external drives
  work). While that drive is offline, TIDAL, Bandcamp and lossless imports wait in the queue and
  continue when it returns. Turn off Settings → Lossless Archive → "Wait for the drive" to keep
  importing instead, with masters waiting in a pending folder until the drive is back.
- **Lossy sources:** kept as they are (no lossy→lossy), except WMA/RealAudio-type formats, which
  become MP3 320.
- **Tags:**
  - MP3 is ID3v2.3 with Picard-compatible frames: MusicBrainz IDs, ISRC, barcode, label, catalog
    number, ReplayGain.
  - Ratings are stored in POPM, which Windows, MusicBee and Android players read.
  - Synced lyrics are stored as LRC in USLT.
- **Artwork:** embedded only, at most 2000×2000. The original full-size image goes to the archive.
- **Identification:** MusicBrainz, matched by ISRC/barcode, existing IDs, AcoustID fingerprints
  (needs a free key) or text search with release scoring. Unsure matches land in Import → Needs
  Review.
- **Duplicates:** a better copy (lossless, or higher bitrate) replaces the old one, which goes to the
  OS trash. Anything else is skipped. Every import writes a report with Undo.

## SiIvaGunner High Quality Rips

Rips live in their own section (sidebar → SiivaGunner: Seasons, Albums, Games, Songs; plus Get Rips)
and their own folder, `~/Music/High Quality Rips/<Album>/<Title>`. The normal views, search, smart
playlists, dedupe and TIDAL/Bandcamp badges leave them out.

- **Marker:** every rip carries `HIGH QUALITY RIP` = `SiIvaGunner` / `SGFR` / `YouTube` and the genre
  `High Quality Rip`, so phone players can separate them too. Get Info → High Quality Rip moves songs
  you already have in or out.
- **Rip albums:** Get Rips → Albums / SGFR list the official Google Drive mirrors from
  highquality.rip and sgfr.highquality.rip, with in-library badges. Downloads use the FLAC folders:
  MP3 320 for the library, FLAC masters to the archive. Drive quota pages back off and retry; a
  CAPTCHA pauses the source for you.
- **YouTube seasons:** set a public playlist of SiIvaGunner uploads (Get Rips → YouTube, or Settings
  → SiIvaGunner). Valence syncs it on startup and every 6 hours, downloads new uploads from the
  SiIvaGunner channel with yt-dlp (best audio, kept as-is), and files each into one album per
  channel season, numbered by upload time. An older rip added later slots in where it was released.
- **Seasons:** the table (names, start dates) lives in `~/Music/.valence/rips/seasons.json` and is
  editable in Settings → SiIvaGunner. Covers start as placeholders; setting one embeds it into every
  rip of that season.
- **yt-dlp** is downloaded on first use from its official GitHub release (SHA-256 checked) into
  Valence's data folder and updated daily. Valence's own Electron serves as its JavaScript runtime.
- MusicBrainz, AcoustID and lyrics lookups are skipped for rips (they'd match the real soundtracks).

## Multi-device model (Syncthing)

- **Files are the truth.** Every file carries its identity in its tags (`VALENCE_ID`, source IDs,
  ISRC, MBIDs), so any device can rebuild its database from a scan.
- **Shared app state** lives in `~/Music/.valence/`. Each device writes only its own logs (plays,
  ledger, ratings, favorites, playlist edits), so Syncthing never sees a conflict. Shared settings
  merge newest-wins per key.
- **Any desktop can import.** Background reorganizing only touches files that device imported. An
  explicit edit renames the file on the device where you made it.
- **Phone:** regular playlists are `~/Music/Playlists/*.m3u8` with relative paths. The Android app
  reads and writes the same `.valence` logs, so favorites, playlists and plays made on the phone
  reach the desktops.
- **Syncthing safety:** Valence maintains a marked block in `~/Music/.stignore`. Files are placed
  atomically via `*.valence-tmp` and a rename, so Syncthing never syncs half-written files.

## Your own themes

JSON files in `~/Music/.valence/themes/` show up as palettes in Settings → Appearance, sync to every
device and reload live. To get a starting file, go to Settings → Appearance → Your themes → Create
example.

```json
{
  "name": "Midnight Ember",
  "scheme": "auto",
  "artTint": false,
  "accent": "#ff7a45",
  "tokens": { "r-lg": "16px" },
  "light": { "bg-solid": "#f6f1ec" },
  "dark": { "bg-solid": "#141010" },
  "css": [".sidebar { letter-spacing: 0.01em; }"]
}
```

- `scheme` is `light`, `dark` or `auto`.
- `artTint: false` turns off album-art coloring.
- `tokens` applies in both modes; `light` and `dark` apply in one mode only.
- `css` is extra CSS.

Token names are any CSS custom property from `src/renderer/theme/theme.css`. A broken file shows its
error under Your themes instead of applying.

## Code map

```
src/shared/      types, IPC channel contracts, path template + sanitizer, tag schema, quality
src/preload/     generic channel bridge (window.valence)
src/main/
  library/       scanner, watcher, indexer, organizer, queries, art cache (valence-art://), playlists
  import/        persistent job queue, pipeline stages, dedupe/upgrade, archive + pending, Inbox, reports/undo
  metadata/      MusicBrainz, AcoustID, Cover Art Archive, LRCLIB, filename heuristics, merge, scoring
  tags/ media/   tag read/write (music-metadata / node-taglib-sharp), ffmpeg transcode, ReplayGain, artwork
  sources/       tidal/ (PKCE auth, browse, BTS/DASH downloader), bandcamp/ (session, collection, FLAC)
  sync/          device logs, plays, claims, HLC settings merge, m3u8, .stignore
  audio/         ffmpeg decode host → MessagePort PCM streams, media protocol, player relay
  integrations/  tray, Discord RPC, media keys
  windows/       mini player, window chrome
src/renderer/
  audio/         Player, queue, worklet + <audio> engines, EQ/RG graph, Media Session
  shell/         App, sidebar, top bar, player bar, right panel (queue/lyrics), command palette
  views/         library/, rips/, settings/, import/, tidal/, bandcamp/
  theme/         tokens, palettes, themes, art-derived accent
  mini/          mini player window
android/         the Android app (Kotlin + Compose): app/, core/ (shared logic), tags/ (tag reading)
```
