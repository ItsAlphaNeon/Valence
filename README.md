# Valence

A personal, iTunes-style music library manager and player. It downloads your TIDAL picks and
Bandcamp purchases, adopts loose files, fills in metadata the way Picard does, and keeps one clean
folder tree in `~/Music` that Syncthing carries to every device: Windows, macOS, Linux and an
Android phone.

The morning-after checklist is in [MORNING.md](MORNING.md).

## What it does

**Sources**
- **TIDAL:**
  - Browse favorites (albums, tracks, playlists), search the catalog, open artist pages, or paste any `tidal.com` link.
  - One click downloads a whole album, track or playlist at LOSSLESS (16/44.1).
  - Badges everywhere show ✓ in library, ◐ partial or ↓ missing.
  - Nothing downloads in bulk on its own.
- **Bandcamp:** your purchased collection (hidden items included) in FLAC, with the same badges and a manual "Download all missing".
- **Loose files:** drag them onto the window, use Import Folder, or drop them into the per-machine Inbox at `~/Valence Inbox`. Files are copied in and the originals are never touched.

**Library**
- **Layout:** `Album Artist/Album (Year)/Title.mp3`, with no track numbers in filenames (they live in the tags). Singles get their own folder, collaborations go under the primary artist, and compilations go under `Various Artists/`.
- **Lossless sources:** transcoded to MP3 320 CBR for the library. The FLAC master goes to an archive folder you choose, which isn't synced and can be on another drive (exFAT/FAT32 external drives work). While that drive is offline, TIDAL, Bandcamp and lossless imports wait in the queue and continue when it returns, so masters never pile up on the main drive. Turn off Settings → Lossless Archive → "Wait for the drive" to keep importing instead, with masters waiting in a pending folder until the drive is back.
- **Lossy sources:** kept as they are (no lossy→lossy), except WMA/RealAudio-type formats, which become MP3 320.
- **Tags:**
  - MP3 is ID3v2.3 with Picard-compatible frames: MusicBrainz IDs, ISRC, barcode, label, catalog number, ReplayGain.
  - Ratings are stored in POPM, which Windows, MusicBee and Android players read.
  - Synced lyrics are stored as LRC in USLT.
- **Artwork:** embedded only, at most 2000×2000. The original full-size image goes to the archive.
- **Identification:** MusicBrainz, matched by ISRC/barcode, existing IDs, AcoustID fingerprints (needs a free key) or text search with release scoring. Unsure matches land in Import → Needs Review.
- **Duplicates:** a better copy (lossless, or higher bitrate) replaces the old one, which goes to the OS trash. Anything else is skipped. Every import writes a report with Undo.

**Player**
- **Engine:** gapless AudioWorklet engine fed by ffmpeg, so any codec plays. Optional crossfade, skipped inside albums.
- **Sound:** ReplayGain (track/album/auto), a 10-band EQ and output device selection.
- **System integration:** the Media Session shows up in Windows media controls, macOS Now Playing and Linux MPRIS.
- **Queue:** Up Next, history, shuffle and repeat. The queue resumes after a restart.
- **Extras:** synced-lyrics karaoke view, mini player (Ctrl/⌘+Alt+M), tray, Discord Rich Presence (optional).
- **Organization:** smart playlists, and a Get Info tag editor that re-paths files when you edit them. Its MusicBrainz tab re-identifies songs and previews every changed field before writing.

**Look**
- Liquid Glass UI that follows system light/dark and is tinted by the playing album's art.
- Four performance tiers (full refraction → blur → flat → minimal). The tier is picked automatically and steps down if frames drop.
- **Your own themes:** JSON files in `~/Music/.valence/themes/` sync to every device and reload live. To get a starting file, go to Settings → Appearance → Your themes → Create example.

  ```json
  {
    "name": "Midnight Ember",
    "scheme": "auto",
    "maxTier": "glass",
    "artTint": false,
    "accent": "#ff7a45",
    "tokens": { "r-lg": "16px" },
    "light": { "bg-solid": "#f6f1ec" },
    "dark": { "bg-solid": "#141010" },
    "css": [".sidebar { letter-spacing: 0.01em; }"]
  }
  ```

  The fields:
  - `scheme` is `light`, `dark` or `auto`.
  - `maxTier` optionally caps the effects tier.
  - `artTint: false` turns off album-art tinting.
  - `tokens` applies in both modes; `light` and `dark` apply in one mode only.
  - `css` is extra CSS.

  Token names are any CSS custom property from `src/renderer/theme/theme.css`. A broken file shows its error under Your themes instead of applying.

## SiIvaGunner High Quality Rips

Rips live in their own section of the library (sidebar → SiIvaGunner: Seasons, Rip Albums, Rip Songs, Get Rips) and in their own folder, `~/Music/High Quality Rips/<Album>/<Title>`. The normal views, search, smart playlists, dedupe and TIDAL/Bandcamp badges leave them out.

- **Marker:** every rip carries `HIGH QUALITY RIP` = `SiIvaGunner` / `SGFR` / `YouTube` and the genre `High Quality Rip`, so phone players can separate them too. Get Info → High Quality Rip moves songs you already have in or out.
- **Rip albums:** Get Rips → Albums / SGFR list the official Google Drive mirrors from highquality.rip and sgfr.highquality.rip, with in-library badges. Downloads use the FLAC folders: MP3 320 for the library, FLAC masters to the archive. Drive quota pages back off and retry; a CAPTCHA pauses the source for you.
- **YouTube seasons:** set a public playlist of SiIvaGunner uploads (Get Rips → YouTube, or Settings → SiIvaGunner). Valence syncs it on startup and every 6 hours, downloads new uploads from the SiIvaGunner channel with yt-dlp (best audio, kept as-is), and files each into one album per channel season, numbered by upload time. An older rip added later slots in where it was released.
- **Seasons:** the table (names, start dates) lives in `~/Music/.valence/rips/seasons.json` and is editable in Settings → SiIvaGunner. Covers start as placeholders; setting one embeds it into every rip of that season.
- **yt-dlp** is downloaded on first use from its official GitHub release (SHA-256 checked) into Valence's data folder and updated daily. Valence's own Electron serves as its JavaScript runtime.
- MusicBrainz, AcoustID and lyrics lookups are skipped for rips (they'd match the real soundtracks).

## Multi-device model (Syncthing)

- **Files are the truth.** Every file carries its identity in its tags (`VALENCE_ID`, source IDs, ISRC, MBIDs), so any device can rebuild its database from a scan.
- **Shared app state** lives in `~/Music/.valence/`. Each device writes only its own logs (plays, ledger, ratings), so Syncthing never sees a conflict. Shared settings merge newest-wins per key.
- **Any desktop can import.** Background reorganizing only touches files that device imported. An explicit edit renames the file on the device where you made it.
- **Phone:** regular playlists are `~/Music/Playlists/*.m3u8` with relative paths. On the phone, ignore `/.valence` in Syncthing.
- **Syncthing safety:** Valence maintains a marked block in `~/Music/.stignore`. Files are placed atomically via `*.valence-tmp` and a rename, so Syncthing never syncs half-written files.

## Development

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
node scripts/e2e-ui.mjs         # every view light/dark/tiers, playback, lyrics, mini player → test-results/ui/
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

## Packaging

```bash
npm run dist:win     # NSIS installer + portable exe → release/
npm run dist:mac     # arm64 dmg (run on the Mac; ad-hoc signed, no Developer ID)
npm run dist:linux   # AppImage, rpm, pacman (run on Linux)
```

### CI builds

`.github/workflows/build.yml` builds everything on GitHub Actions: the Windows setup `.exe` and `.msi`, `Valence.app` zipped for Apple Silicon and Intel, a Linux AppImage, and Android APKs for ARM and x86. Start it from the Actions tab (**Build → Run workflow**), or push a version tag (`git tag v0.2.0 && git push origin v0.2.0`), which also collects the files into a draft release. Each run's files are under **Artifacts** on its summary page.

- **macOS:** the app is ad-hoc signed, not notarized. The first time, right-click it and choose **Open**, or run `xattr -dr com.apple.quarantine Valence.app`.
- **Android signing:** release APKs are signed with the debug key. To make CI's APKs install over the copy already on your phone, add this PC's debug keystore as a repository secret named `ANDROID_DEBUG_KEYSTORE`:

  ```bash
  base64 -w0 ~/.android/debug.keystore | gh secret set ANDROID_DEBUG_KEYSTORE
  ```

  Without it, each run signs with a throwaway key, and Android won't install that over an existing copy.

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
  windows/       mini player
src/renderer/
  audio/         Player, queue, worklet + <audio> engines, EQ/RG graph, Media Session
  shell/         App, sidebar, toolbar, player bar, drawer (queue/lyrics), backdrop
  views/         library/, settings/, import/, tidal/, bandcamp/
  theme/         tokens, Liquid Glass recipe, tiers, themes, art-derived accent
  mini/          mini player window
```
