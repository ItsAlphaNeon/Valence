# Good morning: Valence overnight report

Valence is built, tested and packaged for Windows. Your `~/Music` now holds a first real import of
the 254 sample MP3s: 244 songs in 67 albums, with 3 small releases waiting for your review. Everything below marked **you** needs a login, key or decision only you can provide.

## Install / run

- **Installer:** `release\Valence-Setup-0.1.0.exe` (NSIS; you can choose the install folder).
- **No install:** `release\Valence-Portable-0.1.0.exe`.
- **From source:** `npm run dev`. See [README.md](README.md).
- **SmartScreen:** neither exe is signed, so Windows may show "Windows protected your PC". Choose More info → Run anyway.

Your data lives here:
- **Library:** `C:\Users\Neon\Music`
- **App data:** `%LOCALAPPDATA%\Valence` (database, art cache, tokens, archive-pending)
- **Inbox:** `C:\Users\Neon\Valence Inbox` (drop files here and they import automatically)
- **Old temp library:** moved to `C:\Users\Neon\Music (old temp library)`. Valence never touched it, so delete it whenever you like.

## Checklist (you)

1. **Archive drive.** In Settings → Archive, pick the folder for lossless masters (e.g. on E:). Masters wait in `archive-pending` until then and move over automatically once a folder is set.
2. **TIDAL.** In Settings → Accounts → TIDAL → Log in, then try:
   - favorites (albums, tracks, playlists);
   - search, and check the ✓/◐/↓ badges against your library;
   - downloading **one** album, then confirming it lands as `Artist/Album (Year)/Title.mp3` with its FLAC in the archive.
   - If login fails with an invalid-client error, TIDAL has rotated its app credentials. Paste newer ones under Accounts → TIDAL → Advanced (python-tidal's `client_id_pkce`/`client_secret_pkce`).
3. **Bandcamp.** In Settings → Accounts → Bandcamp → Log in, then check that the collection (including hidden items) and badges show, and download **one** purchase.
4. **Metadata.** In Settings → Metadata:
   - Paste an **AcoustID API key** (free at acoustid.org/new-application; the link opens your browser). Without it, untagged loose files can only be matched by text.
   - Optionally add a **MusicBrainz contact** (an email or URL) for the User-Agent.
5. **Discord (optional).** Create an application at discord.com/developers/applications named "Valence" and paste its Application ID under Settings → Discord. Optionally upload the icon as an art asset named `valence`.
6. **Syncthing.**
   - Re-add `~/Music` as the shared folder. Valence already wrote its ignore block into `~/Music/.stignore`; that file is per-device, so each desktop writes its own.
   - On the **Android phone**, add `/.valence` to the folder's ignore patterns.
7. **Mac and Linux.** On each machine: clone or copy the repo, then run `npm ci`, `npm run fetch-binaries` and either `npm run dist:mac` or `npm run dist:linux`. These builds are unsigned and untested.

## What was verified tonight

| Area | How | Result |
|---|---|---|
| Unit + integration | `npx vitest run` | 435 passed, 1 skipped (live-network test) |
| Import pipeline | integration test: FLAC album + messy loose MP3s → sandbox library | MP3 320 at the right paths, tags re-read, art ≤2000 px, originals archived, RG tags, undo |
| Playback | `scripts/e2e-playback.mjs` | gapless joins, seek accuracy, Windows media controls (SMTC) show Valence |
| UI | `scripts/e2e-ui.mjs` | 50/50, see below |
| Real import | `scripts/real-import.mjs` on `test-data/real` (254 files, live MusicBrainz + LRCLIB) | 68 releases done, 3 waiting in Needs Review, 0 failed, 18 min. 244 songs / 67 albums / 38 artists now in `~/Music`. Details at the end. |
| Packaging | `npm run dist:win`, then `scripts/smoke-packaged.mjs` | Installer (163 MB) and portable exe (149 MB) built, unsigned. The packaged app passed 11/11: bundled ffmpeg and fpcalc run; it imported and played a real sample in a sandbox library; it opened your real `~/Music` (244 songs, 67 albums); no console errors. |

`scripts/e2e-ui.mjs` covered:
- every view in light and dark, with zero console errors;
- all four performance tiers;
- playback started from the track table;
- the karaoke lyrics line following the playhead;
- the mini player mirroring the main window, and its play/pause and next driving it;
- a user theme file being listed, applied and hot-reloaded after an edit;
- the Get Info MusicBrainz tab (the lookup itself isn't clicked, since that needs the network);
- 50,000 songs scrolling at p90 ≈ 9 ms per frame.

Screenshots are in `test-results/ui/`.

## Not tested (needs you or real accounts)

**Accounts and services**
- **TIDAL and Bandcamp:** login, browsing and downloads are only covered by fixture-based tests built from the documented API shapes. No traffic went to either service overnight.
- **Discord Rich Presence:** no Application ID yet.

**Desktop behavior**
- **Tray menu and close-to-tray** (Settings → Appearance → Windows), and the optional global media-key grab (Settings → Playback).
- **Native Mica / glass:** the screenshots can't capture what sits behind the window, so check it by eye.

**Other machines**
- **Multi-device behavior:** import claims, per-device logs and settings merge are covered by unit tests only.
- **Phone side:** whether the Android player shows art, LRC lyrics, POPM ratings and the m3u8 playlists.
- **macOS and Linux builds.**

## Added late in the night (after the main phases)

- **Your own themes:**
  - Drop JSON theme files in `~/Music/.valence/themes/`. They sync to every device and edits apply live.
  - Settings → Appearance → Your themes → **Create example** writes a starting file; the format is in the README.
- **Get Info → MusicBrainz tab:**
  - Re-identifies the selected songs with the same matcher imports use, and lets you pick another release.
  - Shows every field that would change (old → new) before you hit Apply. Files are renamed to match.
- **TIDAL:**
  - A pasted *track* link now shows the song (cover, artist, album, length) and whether it's already in your library before you download.
  - Artist tiles show "✓ N songs in library".
- **Logins resume paused queues:** if a TIDAL or Bandcamp download paused with "Login required", logging in again resumes it. Pauses caused by an abuse signal stay paused until you resume them by hand.
- **Bandcamp:** login changes now reach every open view, both the Bandcamp tab and Settings → Accounts.

## Known gaps / small follow-ups

- **TIDAL:** the account menu shows your country, not your username.
- **TIDAL playlists:** the Favorites list has no per-playlist badges. Open a playlist to see them.
- **Bandcamp:** "Download all missing" reports a count, and items show as queued for ~15 s until their jobs appear.
- **Discord art:** cover images come from the Cover Art Archive, so they only appear for tracks with a MusicBrainz release ID. Others show the `valence` asset.
- **Get Info lookup:** it reads at most the first 200 selected songs.

## The real import, in detail

The sample set was the 254 MP3s pulled from your old temp library before it was moved aside. It went through the same pipeline a dropped folder does.

- **Results:**
  - 244 songs were added.
  - 2 were skipped as duplicates of songs already imported.
  - 8 (in 3 releases) are waiting in Import → Needs Review.
- **MusicBrainz:**
  - 60 of the 68 finished releases matched automatically.
  - The other 8 kept their own tags.
  - 231 of the 244 songs now carry a MusicBrainz release ID.
- **Tags:**
  - ReplayGain is on all 244 songs.
  - 218 have a genre.
  - Lyrics were found for 56: 41 synced (karaoke) and 15 plain.
- **Archive:** 66 original cover images (39 JPG, 27 PNG, 146 MB) are waiting in `archive-pending` until you pick the archive folder. The samples were all MP3, so there are no FLAC masters yet.
- **Needs Review.** Valence held these three because the best match was below 75%:

  | Your files | Best MusicBrainz candidate | Score | Note |
  |---|---|---|---|
  | Valve — Portal 2 Soundtrack (2 files) | *Portal 2 Soundtrack: Songs to Test By* (Aperture Science Psychoacoustic Laboratories) | 61% | Probably right. Use This Release or Import As-Is. |
  | SiIvaGunner — SiIvaGunner (3 files) | *siivagunner's highest quality rips: volume* | 72% | Loose rips with a generic album tag. Import As-Is is likely best. |
  | The Larping Tombstone — Thick Of It (Thick Of HiT) (3 files) | *Thick of It (Thick of HiT) (remix)*, a 1-track single | 67% | Only 1 of your 3 versions is on that release. Import As-Is keeps all three. |

- **Album titles come from the files' own tags.** One example is ミラクルミュージカル's *Hawaii: Part II: Part ii*. Get Info → MusicBrainz can re-match any album you want cleaned up.
- **Screenshots** of the finished library are in `test-results/real-*.png`.
