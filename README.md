# Valence

Valence is a music app for your own collection. It brings music in from where you get it, keeps it
neatly organized in one folder, and plays it on your computers and your Android phone, with your
favorites, playlists and listening history following you everywhere.

It runs on **Windows, macOS and Linux**, with a companion **Android** app for listening on the go.

## Getting music in

- **TIDAL:** browse your favorites, search, or paste a link, and download albums, songs or
  playlists in lossless quality.
- **Bandcamp:** see everything you've bought and download what's missing.
- **SiIvaGunner rips:** download the official "High Quality Rips" album collections, or follow a
  YouTube playlist and pick up new rips automatically. Rips get their own section, kept apart from
  the rest of your music.
- **Your own files:** drag them onto the window, pick a folder, or drop them into the Valence Inbox
  folder. Your originals are never touched.

Valence shows at a glance what you already have, what's partly there and what's missing, and it
never downloads anything in bulk without you asking.

## Keeping it tidy

- Every song is filed into your Music folder as **Artist / Album / Song**.
- Song details, cover art and lyrics are looked up and filled in for you. When Valence isn't sure
  about a match, it asks you instead of guessing.
- Lossless downloads become high-quality MP3s for everyday listening, and the lossless originals go
  to a separate archive folder, which can be on an external drive.
- If you add a better copy of a song you already have, it replaces the old one. Every import can be
  undone.

## Listening

- Gapless playback of any format, with optional crossfade, volume leveling and an equalizer.
- Synced lyrics that follow along with the song.
- Favorites, playlists, smart playlists that fill themselves, and ready-made lists like Recently
  played, Most played and Not played.
- A queue you can rearrange, a sleep timer, a mini player, keyboard shortcuts, and a command palette
  (Ctrl+K) that finds any song or action.
- Listening stats: how much you've listened, your top songs and artists, and when you listen.
- Optional Discord status showing what you're playing.

## How it looks

A clean, flat design modelled on the Musicolet Android player, the same on desktop and phone. The
Now playing screen sits on a blurred copy of the album cover. Pick a palette (Dark, Black, Light,
Midnight, Ember or Paper), choose an accent color, let the playing album color the app, or make
your own theme.

## The phone app

The Android app is for listening. It plays the library your computers keep, with Musicolet-style
tabs for albums, artists, playlists, folders and SiIvaGunner rips, several queues, an equalizer and
a sleep timer. Favorites and playlists you change on the phone sync back to your computers.
Downloading and importing music stay on the desktop.

## Across your devices

Your music lives in one folder (`Music` in your home folder), and [Syncthing](https://syncthing.net)
keeps that folder the same on every computer and on your phone. Valence stores everything it needs
(favorites, playlists, play counts, settings) alongside the music, so each device picks it up
automatically, and any computer can add music.

## Downloading Valence

Every platform is built on GitHub. The newest build is always the **Nightly** release on the
**Releases** page: it's rebuilt each night that something changed, so it has the latest
improvements (and occasionally the latest bugs). Numbered versions appear there as regular releases
when they're published.

| System | File |
|---|---|
| Windows | `Valence-Setup-….exe` (or the `.msi`) |
| macOS | `Valence-…-mac-arm64.zip` for Apple Silicon, `-mac-x64.zip` for Intel; unzip to get Valence.app |
| Linux | `Valence-….AppImage` |
| Android | `Valence-…-arm.apk` for almost every phone; `-x86.apk` for emulators and x86 devices |

Valence isn't signed by Apple or Microsoft, so your system may warn you the first time:

- **Windows:** if "Windows protected your PC" appears, choose **More info → Run anyway**.
- **macOS:** right-click Valence.app and choose **Open**, then confirm.
- **Android:** allow your browser or file manager to install apps when asked.

## For developers

Building from source, testing, packaging and how the code is laid out are covered in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). The Android app lives in [android/](android/).
