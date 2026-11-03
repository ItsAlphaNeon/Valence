# TIDAL fixtures (SYNTHETIC)

Every file here is **SYNTHETIC**. None were captured from TIDAL. They were written by hand from the
response shapes documented in python-tidal (`tidalapi/session.py`, `media.py`, `album.py`,
`user.py`, `playlist.py`) and Waves, and they contain only the fields Valence reads. All ids, UPCs,
ISRCs, image uuids and URLs are made up.

| File | Shape |
| --- | --- |
| `album-multidisc.json` | `GET v1/albums/{id}`: 2 volumes, a version, a UPC |
| `album-multidisc-tracks.json` | `GET v1/albums/{id}/tracks` page: 3 + 2 tracks, a version suffix, MAIN + FEATURED artists, key/keyScale, one non-streamable track |
| `album-va.json`, `album-va-tracks.json` | A Various Artists compilation |
| `lyrics.json` | `GET v1/tracks/{id}/lyrics`: `subtitles` (LRC) and `lyrics` |
| `playbackinfo-*.json` | `GET v1/tracks/{id}/playbackinfopostpaywall`. `manifest` is base64. In BTS manifests, `__SERVER__` is replaced at test time with the local 127.0.0.1 test server. The e2e test swaps the DASH manifest for an MPD that ffmpeg generates and that points at the same server. |
| `dash-tidal.mpd` | TIDAL-style MPD: absolute SegmentTemplate URLs, `$Number$`, and a SegmentTimeline with `r` |
| `dash-protected.mpd` | An MPD with `<ContentProtection>`, which must be refused |
| `support.ts` | Test-only helpers: fake transport router, in-memory secrets/settings, fake context |
