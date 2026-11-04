# Valence for Android: overnight notes

The port works on the emulator (a generic Android 17 image), using your sample library copied onto it: 454 library songs plus 414 SiivaGunner rips. I haven't tried it on a real phone. The code is under `android/`; the desktop app is untouched.

## Do this first (only you can)
1. **Syncthing on the phone:** remove `/.valence` from the Music folder's ignore patterns. Without that, plays, likes and playlists can't sync between the phone and the desktops.
2. **Install** `android/app/build/outputs/apk/release/app-release.apk` (4.9 MB, minified):
   ```
   adb install -r android/app/build/outputs/apk/release/app-release.apk
   ```
   To rebuild it: `cd android`, then `./gradlew :app:assembleRelease` with Android Studio's JBR as `JAVA_HOME`. It's signed with the debug key, so it installs over a debug build and keeps the data. Builds signed with a real release key later need an uninstall first.
3. On first launch, grant **All files access** and pick the Syncthing music folder.

## What works (checked on the emulator)
- **Library**
  - Onboarding and the first scan, reading tags from MP3 (ID3v2.2/2.3/2.4), FLAC, Ogg/Opus, M4A (AAC/ALAC), WAV and AIFF with embedded art. The tag reader is a pure-Kotlin port that matches the desktop's reader file for file on your real library, with the exceptions listed under Known issues.
  - Tabs: **Songs, Albums, Artists, Genres, Folders** (Musicolet-style folder browser with breadcrumbs).
  - Album, artist and genre pages.
  - Search across songs, albums and artists.
  - Re-indexing when the app comes back to the foreground (at most every 30 s), plus *Rescan now*. This also works in the minified release build; I copied an m4a and an opus in, rescanned, checked tags and art, then removed them.
- **SiivaGunner:** a separate tab with seasons and games, separate from the library.
- **Playlists tab**
  - Liked, Recently added, History, your static `.m3u8` playlists, and read-only TIDAL mirrors.
  - On the phone you can create a playlist, add songs to it, remove them, and rename or delete it (long-press it, or use ⋮ on its page).
  - Each change is written to `Playlists/*.m3u8` with an atomic rename, so Syncthing carries it to the desktops. **A delete on the phone deletes it everywhere.**
- **Playback** (Media3)
  - Media notification controls with a Like button.
  - Musicolet-style named queues (up to 20), with a queue screen for reordering, removing, renaming and deleting.
  - Play next / add to queue / play in a new queue.
  - Shuffle and repeat.
  - ReplayGain (off / track / album / auto, plus preamp), fade on play and pause, and the system equalizer with its presets (5 bands on the emulator; real phones vary).
  - Pause when headphones disconnect, a sleep timer, and synced lyrics read from the tags.
  - The queue and position survive an app restart.
- **Now Playing:** big art, a theme tinted by the album art, a seek bar, like, lyrics, queue and a sleep timer.
- **History sync, in the desktop format**
  - Plays (≥50% or 4 min) and skips (<30 s, only while playing) follow the desktop's listen rules.
  - They're written to `.valence/devices/<phoneId>/plays-YYYY-MM.jsonl`; likes go to the phone's own log.
  - The phone reads every desktop's logs, so play counts, history and likes match.
- **Unit tests:** `./gradlew :tags:test :core:test`
  - 12 tags tests and 53 core tests, all passing.
  - One test is skipped: the full-library tags diff, which needs `VALENCE_TAGS_DIFF`. To run it:
    ```
    VALENCE_DUMP=<out.json> npx vitest run --config android/tags/fixtures-src/vitest.config.mts library-dump
    VALENCE_TAGS_DIFF=<out.json> ./gradlew :tags:test --tests app.valence.tags.LibraryDiffTest
    ```
    Keep the `library-dump` filter, or the fixture generator runs too.

## Not tested
- A real phone, real Bluetooth or headset buttons, and real headphone unplugging. The emulator has none of these.
- **The Syncthing round trip:**
  - whether a desktop picks up the phone's plays, likes and `.m3u8` edits;
  - whether conflict copies of a playlist are handled. Such playlists show as read-only on the phone, but none existed to try.
- **Android Auto:** the media browse tree is implemented but has never been connected to a car or the DHU.
- **Smart playlists:** the desktop's SQL is ported, but your library has none.
- **A library much bigger than about 900 songs**, and the very first scan of your full library on a phone.
- A listen cut short when Android kills the app. It should be saved and logged as "stopped" on the next start, but I haven't forced that case.

## Known issues
- In an album's ⋮ menu on its own page, "Go to album" still shows (it just reopens the page).
- Short lengths round to whole minutes ("1 song · 1 min").
- The debug APK is 75 MB because it isn't minified. Use the release one.
- **Two of your files are damaged on disk** and read differently on each platform:
  - *Friendship (Nintendo Switch Version) - DELTARUNE.opus*: the desktop shows 0:00, the phone 2:43.
  - *MEGALOVANIA (Pegboard Nerds Remix).mp3*: the desktop can't read it, the phone can.
- **Where the tag reader differs from the desktop on purpose:**
  - ID3v2.2 frames are mapped to their v2.3 equivalents.
  - MP3 length is a sampled estimate when there's no Xing/VBRI header.
  - M4A bitrate is computed from the `mdat` size.
  - Empty tags become null.
  - Oversized tags are cut at the end of the file.
- **Desktop quirks copied on purpose**, so both sides agree:
  - ID3v2.3 artists are split on `/`.
  - `iTunNORM` shows up as the comment.
  - CBR lengths run about 0.1% long.
- **Smart playlist rating rules:** the phone compares against stars × 20, which is what the desktop's rule editor stores. The desktop's own query compares raw 0–5 values, so the two will disagree on rating rules until the desktop is fixed. No smart playlists exist yet, so nothing differs today.

## Decisions I made for you
- **Android 11+ only (minSdk 30).** All-files access exists only from Android 11. The phone's SQLite also needs the upsert syntax the desktop uses.
- **Tapping a song works like Musicolet:** the list becomes a queue named after it ("Album name", "Songs", "Liked"…). An existing queue with that name is replaced, and up to 20 queues are kept. Settings → Playback → *Tapping a song* switches this to replace / play next / add.
- **Shuffle reorders the queue** (Musicolet-style), so the queue always shows play order.
- **Read-only playlists:** mirrors (TIDAL playlist copies) and playlists with a Syncthing conflict copy can't be edited on the phone. The desktop owns and rewrites them.
- **Renaming a playlist renames its file byte for byte**, so the desktop sees a rename rather than a new playlist. A name already taken gets a suffix, the same way the desktop's `freeName` does it.
- The phone never writes to audio files or tags.
- It writes only:
  - `.valence/devices/<phoneId>/` (plays, likes, `device.json`);
  - the static `Playlists/*.m3u8` you edit on the phone, always re-read first, with relative paths and an atomic rename.
- `.valence/settings.json` is read-only on the phone, and its AcoustID key is never logged.
