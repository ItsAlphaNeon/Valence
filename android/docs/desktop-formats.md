# Valence desktop on-disk formats: spec for the Android (Kotlin) port

Source of truth: the desktop repo at `C:\Users\Neon\Documents\GitHub\Valence` (commit 7b9fc33), checked against the real library at `C:\Users\Neon\Music` and the real DB at `%LOCALAPPDATA%\Valence\valence.db` (opened read-only) on 2026-11-03. Everything below is read-only research. Nothing in the repo or the library was changed.

Paths are written POSIX-style relative to the library root (`<root>` = `C:\Users\Neon\Music` on the desktop, `/storage/emulated/0/Music` on the phone; see §8).

---

## 0. Summary: what the phone may read and write

| Path | Phone reads | Phone writes | Notes |
|---|---|---|---|
| `.valence/devices/<phoneId>/device.json` | — | **yes** | Informational only. Nothing on the desktop reads it. |
| `.valence/devices/<phoneId>/plays-YYYY-MM.jsonl` | yes | **yes (append only)** | Desktops ingest it into `plays`. |
| `.valence/devices/<phoneId>/favorites.jsonl` | yes | **yes (append only)** | Desktops ingest it (LWW by HLC). |
| `.valence/devices/<otherId>/*.jsonl` | **yes** | never | Includes both desktops (`aaaaaaaaaaaaaaaa`, `bbbbbbbbbbbbbbbb`). |
| `.valence/devices/*/ledger.jsonl` | optional | never | Write-only on the desktop; nothing reads it. |
| `.valence/settings.json` | yes | avoid (see §1.11) | Shared and multi-writer, with per-key HLC. Contains an API key in plain text. |
| `.valence/playlists/smart-*.json` | yes | possible, with care (§5) | Whole-doc rewrite; desktop has rename/delete bugs. |
| `.valence/playlists/mirror-*.json` | yes | **never** | Desktop-owned; marks which m3u8s are mirrors. |
| `Playlists/*.m3u8` (static) | yes | **possible, with care (§5.7)** | Whole-file rewrite; Syncthing conflicts are union-merged by the desktop. |
| `Playlists/*.m3u8` that are mirrors | yes | **never** | The desktop regenerates them after every import or scan change. |
| `.valence/locks/*` | ignore | never | Desktop job claims. |
| `.valence/themes/*.json` | optional | never | User CSS themes for the desktop. |
| `.valence/rips/seasons.json`, `rips/covers/` | yes (season order) | never | Absent in the real library, so defaults apply. |
| `.valence/.nomedia` | — | create if missing | Already present on the real library. |
| `<root>/.stignore` | — | the phone's own copy (not synced) | Same managed block (§7). |
| Audio files | yes | **never** | Ratings and VALENCE_ID live only in tags, so the phone cannot change them. |

---

## 1. The `.valence/` layout

### 1.1 Tree (code)

```
<root>/.valence/
  .nomedia                                  # created empty by the desktop if missing
  settings.json                             # shared settings {key: {v, hlc}}
  settings.sync-conflict-*.json             # transient; merged then deleted by the desktop
  devices/<deviceId>/device.json            # {id, platform, lastSeen, appVersion}, indent 1
  devices/<deviceId>/plays-YYYY-MM.jsonl    # monthly (UTC month of the play's start)
  devices/<deviceId>/favorites.jsonl        # single file, never rotated
  devices/<deviceId>/ledger.jsonl           # import ledger, single file (unused by readers)
  playlists/smart-<uuid>.json               # smart playlist doc
  playlists/mirror-<sha1(sourceKey)[0:16]>.json   # source-playlist mirror doc
  locks/<sha1(key)[0:24]>.json              # desktop job claims
  themes/*.json                             # user themes (example.json written on request)
  rips/seasons.json                         # optional SiIvaGunner season table
  rips/covers/<seasonKey>.jpg               # optional season covers
```

Constants (`src/main/sync/device-log.ts`): `VALENCE_DIR = '.valence'`, `deviceDir = <root>/.valence/devices/<deviceId>`.

```ts
/** Creates .valence with a .nomedia marker (keeps Android media scanners out). */
export function ensureValenceDir(libraryRoot: string, deviceId: string, info: Record<string, unknown> = {}): void {
  const dir = deviceDir(libraryRoot, deviceId)
  mkdirSync(dir, { recursive: true })
  const nomedia = join(valenceDir(libraryRoot), '.nomedia')
  if (!existsSync(nomedia)) writeFileSync(nomedia, '')
  writeFileSync(join(dir, 'device.json'), JSON.stringify({ id: deviceId, platform: process.platform, lastSeen: new Date().toISOString(), ...info }, null, 1))
}
```

`info` is `{ appVersion }`. The desktop calls this on every start.

### 1.2 Device ID

The desktop keeps its ID in local app data, not in the synced folder: `<dataDir>/device.json`, where `<dataDir>` is `%LOCALAPPDATA%\Valence` on Windows, `$XDG_DATA_HOME/valence` on Linux, and `<appData>/Valence` elsewhere.

```ts
// src/main/platform/device.ts
export function loadDeviceId(dataDir: string): string {
  const file = join(dataDir, 'device.json')
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { id?: string }
    if (j.id && /^[a-z0-9]{12,}$/.test(j.id)) return j.id
  } catch { /* create */ }
  const id = randomBytes(8).toString('hex')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(file, JSON.stringify({ id, createdAt: new Date().toISOString() }))
  return id
}
```

The ID is 16 lowercase hex characters (8 random bytes). The device folder name under `devices/` **is** the device ID that the desktop stores in `plays.device_id`. The desktop never reads `device` from inside an event.

**Phone:**
- Generate an ID the same way: `SecureRandom` 8 bytes, lowercase hex.
- Store it in app-private storage and exclude it from Android Auto Backup and device transfer. Two phones restored from one backup would share a folder, which breaks the single-writer rule and the `(device_id, hlc)` uniqueness.
- A reinstall may create a new ID. That is harmless, because old folders stay valid history.
- Never write into another device's folder.

### 1.3 `devices/<id>/device.json` (synced)

Real example, 116 bytes, written with `JSON.stringify(x, null, 1)` (one-space indent, no trailing newline):

```json
{
 "id": "bbbbbbbbbbbbbbbb",
 "platform": "win32",
 "lastSeen": "2026-11-04T04:02:16.536Z",
 "appVersion": "0.1.0"
}
```

No code reads it. The About screen only shows this device's own ID. The phone should write `{"id","platform":"android","lastSeen":ISO-8601 UTC with ms,"appVersion"}` atomically (§1.17).

### 1.4 Hybrid logical clock (port verbatim)

```ts
// src/main/sync/hlc.ts
export interface Hlc { ms: number; c: number; d: string }

export class HlcClock {
  private last: Hlc
  constructor(private deviceId: string, private now: () => number = Date.now) {
    this.last = { ms: 0, c: 0, d: deviceId }
  }
  tick(): string {
    const ms = Math.max(this.now(), this.last.ms)
    this.last = ms === this.last.ms ? { ms, c: this.last.c + 1, d: this.deviceId } : { ms, c: 0, d: this.deviceId }
    return encodeHlc(this.last)
  }
  observe(remote: string): void {
    const r = decodeHlc(remote)
    if (!r) return
    const ms = Math.max(this.now(), this.last.ms, r.ms)
    let c = 0
    if (ms === this.last.ms && ms === r.ms) c = Math.max(this.last.c, r.c) + 1
    else if (ms === this.last.ms) c = this.last.c + 1
    else if (ms === r.ms) c = r.c + 1
    this.last = { ms, c, d: this.deviceId }
  }
}

export function encodeHlc(h: Hlc): string {
  return `${h.ms.toString(36).padStart(9, '0')}-${h.c.toString(36).padStart(4, '0')}-${h.d}`
}
export function decodeHlc(s: string): Hlc | null {
  const m = /^([0-9a-z]+)-([0-9a-z]+)-(.+)$/.exec(s)
  if (!m) return null
  return { ms: parseInt(m[1], 36), c: parseInt(m[2], 36), d: m[3] }
}
export function compareHlc(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
```

How it behaves:
- An HLC is `9 base36 chars of epoch ms` + `-` + `4 base36 chars of counter` + `-` + `deviceId`, for example `0mw1lk7za-0000-aaaaaaaaaaaaaaaa`.
- Order is **plain string comparison**. Kotlin `String.compareTo` gives the same result, because everything is ASCII.
- The device ID breaks ties.

Desktop usage:
- Two separate `HlcClock` instances share the same device ID: one for the device logs (plays, favorites, ledger) and one for shared settings.
- The log clock is **not persisted**. On startup it calls `observe(max(favorites.hlc))`, so new likes sort after everything seen. Play HLCs only need to be unique per device.
- `ingest()` of favorites observes the last HLC it read. The settings clock observes every HLC in `settings.json` each time it loads.

**Phone:**
- Port this exactly, using Kotlin `Long.toString(36)` (lowercase) and `padStart`.
- Persist the last HLC you emitted and `observe()` it on startup, along with the max favorites HLC from every device. That protects against the phone clock going backwards.
- Risk: if any device's clock runs far ahead, its HLCs win LWW until real time catches up, and every observer inherits the future ms. Consider refusing to `observe` HLCs more than about a day ahead of `now`. The desktop has no such guard.

### 1.5 Appending (port verbatim)

```ts
// DeviceLog (src/main/sync/device-log.ts)
append(name: string, event: Record<string, unknown>, opts: { monthly?: boolean; at?: number } = {}): LogEvent {
  const dir = deviceDir(this.libraryRoot, this.deviceId)
  mkdirSync(dir, { recursive: true })
  const file = opts.monthly ? `${name}-${new Date(opts.at ?? Date.now()).toISOString().slice(0, 7)}.jsonl` : `${name}.jsonl`
  const ev = { hlc: this.clock.tick(), ...event }
  appendFileSync(join(dir, file), JSON.stringify(ev) + '\n')
  return ev
}

/** Appends several events to `<name>.jsonl` in one write (each gets its own, increasing HLC). */
appendMany(name: string, events: Array<Record<string, unknown>>): LogEvent[] {
  if (!events.length) return []
  const dir = deviceDir(this.libraryRoot, this.deviceId)
  mkdirSync(dir, { recursive: true })
  const out = events.map((e) => ({ hlc: this.clock.tick(), ...e }))
  appendFileSync(join(dir, `${name}.jsonl`), out.map((e) => JSON.stringify(e) + '\n').join(''))
  return out
}
```

Format:
- JSON Lines in UTF-8 without a BOM. Each line is one compact JSON object, terminated by `\n` (LF).
- `hlc` is the first key. Readers don't depend on key order, but keep it for byte-likeness.
- Within one device's file, lines are in strictly increasing HLC order (verified on the real logs).
- **Monthly rotation**: the file name uses the **UTC** month of `opts.at`. For plays, that is the play's *start* time, so a play started at 23:30 local on Oct 31 in UTC-7 lands in `plays-2026-11.jsonl`. Kotlin: `DateTimeFormatter.ofPattern("yyyy-MM").withZone(ZoneOffset.UTC)`.

**Phone writer rules:**
- Write each event or batch as **one** `write()` of complete lines in append mode: `FileOutputStream(file, true)`, or SAF `openFileDescriptor(uri, "wa")`. Never rewrite or truncate a log.
- Numbers must be integers (`387`, not `387.0`). Use `Long`/`Int` in your serializer. Booleans are encoded as `1`/`0`, not `true`/`false`.
- Don't create a log file just to hold nothing.

### 1.6 Incremental reading with cursors (port verbatim)

```ts
/**
 * Reads new complete lines from every device's logs matching `prefix` since the stored cursors.
 * A trailing partial line (mid-sync) is left for the next read. A file that shrank is re-read.
 */
export function readNewEvents(db: DB, libraryRoot: string, prefix: string): ReadEvent[] {
  const root = join(valenceDir(libraryRoot), 'devices')
  if (!existsSync(root)) return []
  const getCur = db.prepare('SELECT offset, size, mtime_ms FROM log_cursors WHERE file = ?')
  const setCur = db.prepare(
    'INSERT INTO log_cursors(file, offset, size, mtime_ms) VALUES (?, ?, ?, ?) ON CONFLICT(file) DO UPDATE SET offset = excluded.offset, size = excluded.size, mtime_ms = excluded.mtime_ms',
  )
  const out: ReadEvent[] = []
  for (const deviceId of readdirSync(root)) {
    const dir = join(root, deviceId)
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl') && !f.includes('.sync-conflict-'))
    } catch {
      continue
    }
    for (const f of files.sort()) {
      const abs = join(dir, f)
      const key = `${deviceId}/${f}`
      const st = statSync(abs)
      const cur = getCur.get(key) as { offset: number; size: number; mtime_ms: number } | undefined
      let offset = cur && cur.offset <= st.size ? cur.offset : 0
      if (cur && cur.offset === st.size && cur.mtime_ms === Math.round(st.mtimeMs)) continue
      const fd = openSync(abs, 'r')
      try {
        const size = fstatSync(fd).size
        const buf = Buffer.alloc(size - offset)
        readSync(fd, buf, 0, buf.length, offset)
        const text = buf.toString('utf8')
        const lastNl = text.lastIndexOf('\n')
        if (lastNl < 0) continue
        for (const line of text.slice(0, lastNl).split('\n')) {
          if (!line.trim()) continue
          try {
            const ev = JSON.parse(line) as LogEvent
            if (ev && typeof ev.hlc === 'string') out.push({ ...ev, deviceId, file: f })
          } catch {
            /* skip corrupt line */
          }
        }
        offset += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8')
        setCur.run(key, offset, size, Math.round(st.mtimeMs))
      } finally {
        closeSync(fd)
      }
    }
  }
  return out.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0))
}
```

Schema: `log_cursors(file TEXT PRIMARY KEY, offset INTEGER, size INTEGER, mtime_ms INTEGER)`. The key is `<deviceId>/<fileName>`; real keys look like `bbbbbbbbbbbbbbbb/plays-2026-11.jsonl`.

Semantics to keep:
- It is called once per prefix (`'plays'`, `'favorites'`). The prefix match is a plain `startsWith`, so `plays-2026-11.jsonl` matches.
- Skipped: Syncthing temp files (`~syncthing~…tmp` doesn't start with the prefix), `.sync-conflict-` copies, and the device's own folder. The device's **own** folder is read too, and idempotent inserts make that harmless.
- Only complete lines are consumed. A trailing partial line stays for the next pass.
- If the file shrank below the cursor, it is re-read from 0. Idempotency (§1.8, §1.9) makes that safe.
- Corrupt lines are skipped silently, and so are lines without a string `hlc`.
- The result is globally sorted by HLC across all devices and files.

**Kotlin port notes:**
- Work on **bytes**. Find the last `0x0A` in the byte buffer, consume exactly that many bytes, and decode each line as UTF-8. The desktop decodes and then re-measures, so its cursor would drift if a line contained invalid UTF-8. Working on bytes avoids that.
- Use your own local DB table for cursors. Never store them in the synced folder.
- On Android, `File.lastModified()` has 1 s resolution on some filesystems. Compare size first, then mtime.

### 1.7 What the desktop does with other devices' logs

- **Startup:** `playlists.indexAll()`, then `plays.ingest()`, then `ingestFavorites()`.
- **Watcher:** a change under `.valence/` triggers `plays.ingest()` and `favorites.ingest()`, debounced 2.5 s. A change under `.valence/playlists/` also triggers a playlist reindex.
- **Every 30 minutes:** a full audio rescan runs. It does not ingest logs.
- **`ledger.jsonl` and `device.json`:** never read.
- **Play rekeys:** these are local `UPDATE plays SET track_key` statements and are **not logged** (§2.7). Every other device keeps the old key for those plays.

### 1.8 Plays log

The event is written by `PlayLog.record`:
```ts
this.log.append('plays', { k: p.trackKey, at: p.playedAt, ms: Math.round(p.ms), c: p.completed ? 1 : 0, s: p.skipped ? 1 : 0 }, { monthly: true, at: p.playedAt })
```

| field | type | meaning |
|---|---|---|
| `hlc` | string | ticked when the play is *recorded*, at its end |
| `k` | string | track key (§2.1): VALENCE_ID UUID or `path:<rel_path>` |
| `at` | int | epoch ms when listening **started** (`startedAt`) |
| `ms` | int | ms actually listened (§6.1) |
| `c` | 0/1 | ended naturally (`reason === 'completed'`) |
| `s` | 0/1 | a skip event (§6.1) |

Ingest is idempotent through the primary key `(device_id, hlc)`:
```ts
'INSERT OR IGNORE INTO plays(device_id, hlc, track_key, played_at, ms, completed, skipped) VALUES (?, ?, ?, ?, ?, ?, ?)'
// for (const e of events) { if (typeof e.k !== 'string') continue
//   n += insert.run(e.deviceId, e.hlc, e.k, Number(e.at) || 0, Number(e.ms) || 0, e.c ? 1 : 0, e.s ? 1 : 0).changes }
```

Real lines:
```
{"hlc":"0mw1lds8d-0000-aaaaaaaaaaaaaaaa","k":"66f343d2-8370-43c5-b699-b3315a3b995d","at":1793765024371,"ms":387,"c":0,"s":1}
{"hlc":"0mw0rm3gl-0000-bbbbbbbbbbbbbbbb","k":"1ff9e937-61cd-40aa-9d49-db7b7170f148","at":1793714911707,"ms":113541,"c":1,"s":0}
```

### 1.9 Favorites log

`src/main/sync/favorites.ts`:
- `FAVORITES_LOG = 'favorites'`, a single file `favorites.jsonl`, written with `appendMany`.
- Kinds: `FAVORITE_CODE = { track: 't', album: 'a', artist: 'r' }`.
- Event: `{hlc, kind: 't'|'a'|'r', k: <key>, on: 1|0, at?: <epoch ms>}`. `at` is present only when a like follows an item to a new key (moveKey), so the original liked time is kept.

```ts
// local table: favorites(kind TEXT, item_key TEXT, liked INTEGER, hlc TEXT, at INTEGER, PRIMARY KEY(kind, item_key))
this.upsert = db.prepare(
  `INSERT INTO favorites(kind, item_key, liked, hlc, at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(kind, item_key) DO UPDATE SET liked = excluded.liked, hlc = excluded.hlc, at = excluded.at
   WHERE excluded.hlc > favorites.hlc`,
)
// constructor: const max = db.prepare('SELECT max(hlc) AS h FROM favorites').get(); if (max.h) clock.observe(max.h)

private apply(e) {
  const at = typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : (decodeHlc(e.hlc)?.ms ?? Date.now())
  return this.upsert.run(e.kind, e.k, e.on ? 1 : 0, e.hlc, Math.round(at)).changes
}

set(kind, keys, liked, at?) {
  const todo = [...new Set(keys.filter((k) => typeof k === 'string' && k.length > 0))].filter((k) => (this.get(kind, k)?.liked ?? false) !== liked)
  if (!todo.length) return 0
  const events = this.log.appendMany(FAVORITES_LOG, todo.map((k) => ({ kind, k, on: liked ? 1 : 0, ...(at !== undefined ? { at } : {}) })))
  // apply each in one transaction
}

ingest() {
  const events = readNewEvents(this.db, this.libraryRoot, FAVORITES_LOG)
  // skip if !isCode(e.kind) || typeof e.k !== 'string' || !e.k; apply; track max hlc
  if (last) this.clock.observe(last)
}
```

Semantics:
- Last writer wins per `(kind, key)` by HLC. Unliked rows stay with `liked = 0`.
- `at` means "liked at" (used for the Liked sort). Re-liking something already liked logs nothing, so the original time is kept.
- `set` logs only real state changes.

Real lines (a like, then an unlike 1 s later):
```
{"hlc":"0mw1lk7za-0000-aaaaaaaaaaaaaaaa","kind":"t","k":"387bc1bd-fd8c-495e-9230-431716b91784","on":1}
{"hlc":"0mw1lk8wg-0000-aaaaaaaaaaaaaaaa","kind":"t","k":"387bc1bd-fd8c-495e-9230-431716b91784","on":0}
```

### 1.10 Ledger log (write-only)

Written by the import pipeline for `add` and `upgrade` actions:
```ts
library.deviceLog.append('ledger', { op: a.kind, rel: a.relPath, keys: release.releaseKeys, report: reportId, q: a.detail?.quality })
```

```
{"hlc":"0mw1my6eg-0001-aaaaaaaaaaaaaaaa","op":"add","rel":"Liquicity/Lunar (2024)/Earth.mp3","keys":["tidal:album:392727866","upc:8721093710004"],"report":"8480e5fc-a04e-46e7-910b-bd7400b74e18","q":"lossless:16:44100"}
```

- `keys` prefixes seen: `tidal:`, `upc:`, `bc:`, `youtube:`, `import:`.
- `q` is a source-quality string, either `lossless:<bits>:<rate>` or `lossy:<codec>:<kbps>`.
- **No code reads it.** The phone must not write it.
- Optional use: `rel` plus `decodeHlc(hlc).ms` is a cross-device "date added". The desktop's own `added_at` is local first-scan time, so it differs per device. `rel` goes stale when a file moves.

### 1.11 `settings.json` (shared settings)

`src/main/settings.ts`:
- A key is shared (stored in `.valence/settings.json`) if it starts with one of `library.`, `transcode.`, `art.`, `genre.`, `metadata.`, `import.`, `discord.`, `lyrics.`. Every other key is device-local.
- Doc shape: `{ "<key>": { "v": <any JSON>, "hlc": "<hlc>" } }`, written as `JSON.stringify(doc, null, 1)`.
- Writes are atomic: `writeFileSync('settings.json.<pid>.valence-tmp')` then `renameSync` over the original.

```ts
export function mergeShared(a: SharedDoc, b: SharedDoc): SharedDoc {
  const out: SharedDoc = { ...a }
  for (const [k, e] of Object.entries(b)) if (!out[k] || e.hlc > out[k].hlc) out[k] = e
  return out
}
// load: doc = settings.json; for each /^settings\.sync-conflict-.*\.json$/ in .valence: doc = mergeShared(doc, conflict); unlink(conflict)
//       if merged: persist; for every entry: clock.observe(e.hlc)
// set(key): shared = load(); shared[key] = { v, hlc: clock.tick() }; persist
```

Real content (secret redacted):
```json
{
 "metadata.acoustidKey": { "v": "<redacted>", "hlc": "0mw0tk76s-0000-bbbbbbbbbbbbbbbb" },
 "discord.enabled": { "v": true, "hlc": "0mw0x84ai-0001-bbbbbbbbbbbbbbbb" },
 "discord.clientId": { "v": "1567218752943030413", "hlc": "0mw0x99gk-0002-bbbbbbbbbbbbbbbb" },
 "library.rips.youtubePlaylist": { "v": "https://www.youtube.com/watch?v=H9ByVsw8wgU&list=PL9jkqY4gNPnNyB_W8Xyd2zbraO1BfWvom&pp=sAgC", "hlc": "0mw0z8mln-0003-bbbbbbbbbbbbbbbb" }
}
```

Shared keys referenced in code: `library.template`, `library.rips.youtubePlaylist`, `transcode.profile`, `art.maxSize`, `art.archiveOriginals`, `metadata.musicbrainz`, `metadata.mbContact`, `metadata.acoustidKey`, `import.inbox`, `import.pausedSources`, `import.replaygain`, `lyrics.fetch`, `discord.enabled`, `discord.clientId`. None of them matter for playback.

**Phone:** read only. If the phone ever writes this file, it must re-read, apply `mergeShared` with every conflict copy, set `{v, hlc: tick()}` with a clock that has observed every HLC in the doc, then write via `*.valence-tmp` and rename. It must *not* delete conflict copies: the desktops do that, and racing them creates more conflicts. The file holds an AcoustID API key in plain text. Never log it or send it anywhere.

### 1.12 `playlists/` docs

See §5.2. Docs are written as `JSON.stringify(doc, null, 1)` via `<file>.valence-tmp` and rename. Readers skip names containing `.sync-conflict-`, and **those conflict copies are never merged or cleaned up**.

### 1.13 `locks/` (desktop job claims)

`src/main/sync/claims.ts`:
- One file per claim key: `.valence/locks/<sha1(key).hex.slice(0,24)>.json` holding `{deviceId, keys, ts, ttlMs}`. The default TTL is 2 h.
- A claim held by another device counts while `now - ts < ttlMs`.
- `release` unlinks this device's files.
- `sweep()` at startup deletes this device's expired claims and any claim older than 7 days. Unparsable files are skipped and never deleted.
- Claim keys are an import job's release keys minus `import:*`. A busy key retries after 10 min.

The phone runs no jobs, so it **ignores this folder completely**. On the real disk it holds only six `~syncthing~<hex>.json.tmp` leftovers (§8.1).

### 1.14 `themes/`

Desktop user themes: `*.json` holding `name`, `description`, `scheme`, `maxTier`, `artTint`, `accent` (`#rrggbb`), `tokens`/`light`/`dark`, and `css`. Limits: 256 KB per file, 64 KB of CSS. The desktop writes `example.json` (indent 2) only on request. The folder is empty in the real library. The phone can ignore it.

### 1.15 `rips/`

- `rips/seasons.json` holds `{"seasons":[{"key","name","start":"YYYY-MM-DD"}]}`, validated and sorted by `start`, written with indent 1 via `.valence-tmp`. If the file is missing or invalid, `DEFAULT_SEASONS` applies (§4.3).
- Covers live at `rips/covers/<key with [^a-z0-9_-] → _>.jpg` and are only used when importing. Files already carry embedded art.
- In the real library this folder is **absent**, so the defaults apply.

### 1.16 `.nomedia`

The desktop creates `.valence/.nomedia` (empty) if it is missing, which keeps MediaStore out of `.valence`. The phone may create it the same way.

### 1.17 Temp files and atomic writes

- Every desktop rewrite of a whole file goes through `<file>.valence-tmp` followed by a rename. Settings use `<file>.<pid>.valence-tmp`.
- `*.valence-tmp` is in the managed `.stignore` block (§7), and `isIgnoredName` skips it.
- The phone should use the same suffix for its atomic writes (`device.json`, m3u8, smart docs), and should have the same `.stignore` block so its Syncthing never sends temp files.

---

## 2. Track identity

### 2.1 Track key (plays and track likes)

```ts
// SQL form (favorites.ts) — also the expression of index tracks_item_key
export function trackKeySql(alias = 't'): string {
  return `coalesce(${alias}.valence_id, 'path:' || ${alias}.rel_path)`
}
// service.recordPlay: trackKey = t.valenceId ?? `path:${t.relPath}`
```

- `valence_id` is the `VALENCE_ID` tag, read raw with no cleaning (a lowercase UUID v4 from `randomUUID()`, or a derived v5-style UUID, §2.8).
- In the real DB **every track has one**, and there are **0** path-keyed plays. Path keys only exist for files that were never imported through Valence.

### 2.2 `rel_path`

- It is the library-relative path made of `readdir` names joined with `/`. The desktop does **no** Unicode normalization or case folding.
- `path_key = foldKey(rel_path)` exists for case-insensitive collision checks only.
- Path-keyed items (`path:<rel_path>`) and playlist entries need an **exact** byte-for-byte match: same case, same normalization form.
- All real rel_paths are NFC, and every audio file is at depth 3.
- **Phone:** build rel_paths from directory listing names exactly. Don't run NFC/NFD on them. Do check that they're NFC, and warn if not.

### 2.3 `album_key` (album likes)

```ts
// src/main/library/indexer.ts
export function relDirOf(relPath: string): string {
  const i = relPath.lastIndexOf('/')
  return i < 0 ? '' : relPath.slice(0, i)
}
/** Groups files of one release: same folder + same album title. */
export function albumKeyFor(relPath: string, tags: TrackTags): string {
  return `${foldKey(relDirOf(relPath))}|${matchKey(tags.album || tags.title || '')}`
}

// src/shared/sanitize.ts
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u00AD\u180E]/g   // (source has literal chars)
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g

export function cleanText(input: string | undefined | null): string {
  if (!input) return ''
  return input.normalize('NFC').replace(ZERO_WIDTH, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
}
export function foldKey(s: string): string {
  return s.normalize('NFC').toLocaleLowerCase('en-US')
}
export function matchKey(s: string | undefined | null): string {
  return cleanText(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
```

- `tags.album` is the cleaned album tag (standard fields pass through `cleanText` on read).
- `tags.title` is the cleaned title tag. It is **not** the file-stem fallback that the `title` column uses.
- If both are missing, the key ends in `|` followed by an empty string.

Real examples:
- `100 gecs/10,000 gecs (2023)|10 000 gecs`
- `high quality rips/siivagunner - season 7 – the year of grand dad|siivagunner season 7 year of grand dad`

**Kotlin pitfalls. These must match, or album likes won't line up:**
1. JS `\b` is an **ASCII** word boundary (`\w` = `[A-Za-z0-9_]`). Android's ICU regex `\b` is Unicode-aware. For example, `"Кa"` loses the `a` in JS but not in ICU. Implement the article strip by hand: a match of `the|a|an` counts only when the previous and next chars are not `[A-Za-z0-9_]` (or are at the string edges).
2. JS `\s` is Unicode whitespace: `[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]`. Java's `\s` is ASCII-only unless `(?U)` is set. Use that explicit class. JS `.trim()` strips the same set plus line terminators.
3. Use `Normalizer.normalize(s, NFKD)` and `lowercase(Locale.ROOT)`. Both match JS `toLowerCase()` and `toLocaleLowerCase('en-US')`.
4. `[^\p{L}\p{N}]+` works in Java and ICU as is.
5. Feed `matchKey` the same text the desktop reads. That means the first value of the album and title fields, read with the same frame precedence (§3.4). A phone tag library that joins multi-value fields differently will produce different keys.

### 2.4 Effective album artist

```ts
export function effectiveAlbumArtist(tags: TrackTags): string {
  if (tags.compilation || isVariousArtists(tags.albumartist)) return VARIOUS_ARTISTS   // 'Various Artists'
  return tags.albumartist || tags.artist || 'Unknown Artist'
}
export function isVariousArtists(name) {
  const n = cleanText(name).toLowerCase()
  return n === 'various artists' || n === 'various' || n === 'va' || n === 'v.a.' || n === 'verschiedene interpreten'
}
// trackRecord: artist = t.artist || t.albumartist || ''; title = t.title || stemOf(relPath)
//              compilation = t.compilation || albumArtist === 'Various Artists' ? 1 : 0
```

### 2.5 Artist likes

```ts
export function artistFavoriteKey(name: string): string {
  return name.trim().toLowerCase().normalize('NFC')
}
```

`name` is an album-artist name as shown in the Artists view, which is the effective album artist (§2.4). Artist likes are keyed by that name, not by an ID.

### 2.6 Favorite kinds

| kind | code | key |
|---|---|---|
| track | `t` | track key (§2.1) |
| album | `a` | `album_key` (§2.3) |
| artist | `r` | `artistFavoriteKey(albumArtist)` (§2.5) |

### 2.7 Key moves (`moveKey`) and local-only rekeys

```ts
moveKey(kind: FavoriteCode, from: string, to: string): boolean {
  if (!from || !to || from === to) return false
  const row = this.get(kind, from)
  if (!row?.liked) return false
  const target = this.get(kind, to)
  this.set(kind, [to], true, target?.liked ? target.at : row.at)
  this.set(kind, [from], false)
  return true
}
```

When the desktop moves keys:
- **Album folder changes** (tag edits move files). `followLikedAlbums` calls `moveKey('a', oldAlbumKey, newAlbumKey)`. This is logged as an unlike of the old key plus a like of the new key with `at`.
- **A path-keyed track gets a VALENCE_ID** (an import upgrade replaces the file, or a tag edit moves a path-keyed file). `rekeyTrack` runs:
  ```ts
  this.db.prepare('UPDATE plays SET track_key = ? WHERE track_key = ?').run(to, from)   // LOCAL ONLY, not logged
  this.favorites.moveKey('t', from, to)                                                 // logged
  ```
  So other devices (and the phone) keep those plays under the old `path:` key. They become orphans unless the phone applies the same mapping. In practice this is negligible, because all real tracks have IDs.
- **Undo of an import** reverses rekeys locally as well.

### 2.8 VALENCE_ID lifecycle

- **Import:** `valence_id = probe.tags.valence_id ?? merged.valence_id ?? randomUUID()`, and `valence_owner = <importing deviceId>`. An upgrade keeps the old file's ID, so history follows the new file.
- **Moves:** a known VALENCE_ID whose old path vanished is treated as a move. The row and its history are kept.
- **Shared IDs (edits):** a file cut from another (for example a radio edit) can carry the same ID. After each scan, `repairSharedIds()` keeps the ID on the earliest-added file (or the shortest name within 60 s) and rewrites the copy's tags with:
  ```ts
  export function derivedValenceId(shared: string, relPath: string): string {
    const h = createHash('sha1').update(`valence-id|${shared}|${relPath.normalize('NFC').toLowerCase()}`).digest()
    h[6] = (h[6] & 0x0f) | 0x50
    h[8] = (h[8] & 0x3f) | 0x80
    const x = h.subarray(0, 16).toString('hex')
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
  }
  ```
- **Repair rules:** only files owned by this device (or with no owner) are re-tagged. Two files with the same size and a duration within 1 s are skipped, because that is one file seen at two paths.
- **Real DB:** 1 shared ID exists. Expect a desktop to rewrite that copy's tags, and the phone to see the file change through Syncthing.
- **Phone:** never assign IDs (that would need tag writes). Treat the tag as authoritative and re-read tags whenever size or mtime changes. When the phone sees two files with the same ID, it must still treat them as two rows, as the desktop player does (`id = t<rowId>`). Plays and likes go to the shared key.

---

## 3. Tags per container

The desktop writes with node-taglib-sharp (`src/main/tags/write.ts`) and reads with music-metadata (`src/main/tags/read.ts`). The field naming follows Picard.

### 3.1 Standard fields

| TrackTags | MP3: ID3v2.3, UTF-16 | Vorbis comment (FLAC / Ogg / **Opus**) | MP4 / M4A |
|---|---|---|---|
| title | TIT2 | TITLE | ©nam |
| artist (display credit) | TPE1 | ARTIST | ©ART (one value) |
| artists (multi) | TXXX:ARTISTS (`; `-joined) | ARTISTS (one field per value) | ----:com.apple.iTunes:ARTISTS |
| album | TALB | ALBUM | ©alb |
| albumartist | TPE2 | ALBUMARTIST | aART |
| albumartistsort | TSO2 | ALBUMARTISTSORT | soaa |
| artistsort / titlesort / albumsort | *not written* | ARTISTSORT / TITLESORT / ALBUMSORT | soar / sonm / soal |
| tracknumber/totaltracks | TRCK `n/total` | TRACKNUMBER + TRACKTOTAL + TOTALTRACKS | trkn |
| discnumber/totaldiscs | TPOS `n/total` | DISCNUMBER + DISCTOTAL + TOTALDISCS | disk |
| date | TYER `YYYY` + TDAT `DDMM` | DATE (full `YYYY-MM-DD` when known) | ©day (**year only**) |
| originaldate | TORY (year; written as TDOR, rendered v2.3) + TXXX:ORIGINALDATE | ORIGINALDATE + ORIGINALYEAR | ----:ORIGINALDATE |
| genre | TCON (text, no numeric refs) | GENRE | ©gen |
| compilation | TCMP `1` | COMPILATION `1` | cpil |
| isrc | TSRC | ISRC | ----:ISRC |
| label | TPUB | LABEL | ----:LABEL |
| copyright | TCOP | COPYRIGHT | cprt |
| composer | TCOM | COMPOSER | ©wrt |
| bpm | TBPM (int) | BPM | tmpo |
| key | TKEY | KEY | ----:initialkey |
| media | TMED | MEDIA | ----:MEDIA |
| comment | COMM (desc `''`, lang `eng`) | COMMENT | ©cmt |
| lyrics | USLT (desc `''`, lang `eng`); LRC text when synced | LYRICS | ©lyr |
| MB recording ID | UFID owner `http://musicbrainz.org` (Latin-1) | MUSICBRAINZ_TRACKID | ----:MusicBrainz Track Id |
| rating | POPM, email `Windows Media Player 9 Series` | RATING = stars×20 | ----:RATING = stars×20 |
| explicit | TXXX:ITUNESADVISORY `1` | ITUNESADVISORY `1` | ----:ITUNESADVISORY |
| cover | APIC FrontCover (Latin-1 desc) | FLAC PICTURE / METADATA_BLOCK_PICTURE | covr |

- MP3 files get ID3v1 and APE tags removed, and ID3v2.3 is forced.
- With `clean` (the default), FLAC/Ogg files have all Vorbis fields replaced and MP4 files have the tag cleared, then the fields above are written again.

### 3.2 Custom fields (`CUSTOM_FIELDS` in `src/shared/tag-schema.ts`)

Format: `[TrackTags key, ID3 TXXX description, Vorbis field, MP4 freeform name under com.apple.iTunes]`.

| key | ID3 TXXX | Vorbis | MP4 |
|---|---|---|---|
| artists | ARTISTS | ARTISTS | ARTISTS |
| catalognumber | CATALOGNUMBER | CATALOGNUMBER | CATALOGNUMBER |
| barcode | BARCODE | BARCODE | BARCODE |
| musicbrainz_trackid (release track) | MusicBrainz Release Track Id | MUSICBRAINZ_RELEASETRACKID | MusicBrainz Release Track Id |
| musicbrainz_albumid | MusicBrainz Album Id | MUSICBRAINZ_ALBUMID | MusicBrainz Album Id |
| musicbrainz_releasegroupid | MusicBrainz Release Group Id | MUSICBRAINZ_RELEASEGROUPID | MusicBrainz Release Group Id |
| musicbrainz_artistid | MusicBrainz Artist Id | MUSICBRAINZ_ARTISTID | MusicBrainz Artist Id |
| musicbrainz_albumartistid | MusicBrainz Album Artist Id | MUSICBRAINZ_ALBUMARTISTID | MusicBrainz Album Artist Id |
| releasetype | MusicBrainz Album Type | RELEASETYPE | MusicBrainz Album Type |
| releasestatus | MusicBrainz Album Status | RELEASESTATUS | MusicBrainz Album Status |
| releasecountry | MusicBrainz Album Release Country | RELEASECOUNTRY | MusicBrainz Album Release Country |
| acoustid_id | Acoustid Id | ACOUSTID_ID | Acoustid Id |
| originaldate | ORIGINALDATE | ORIGINALDATE | ORIGINALDATE |
| **valence_id** | VALENCE_ID | VALENCE_ID | VALENCE_ID |
| **valence_owner** | VALENCE_OWNER | VALENCE_OWNER | VALENCE_OWNER |
| tidal_track_id / tidal_album_id | TIDAL_TRACK_ID / TIDAL_ALBUM_ID | same | same |
| bandcamp_item_id / bandcamp_track_id / bandcamp_url | BANDCAMP_ITEM_ID / BANDCAMP_TRACK_ID / BANDCAMP_URL | same | same |
| source | VALENCE_SOURCE | VALENCE_SOURCE | VALENCE_SOURCE |
| source_quality | VALENCE_SOURCE_QUALITY | VALENCE_SOURCE_QUALITY | VALENCE_SOURCE_QUALITY |
| **hq_rip** | **HIGH QUALITY RIP** | **HIGH QUALITY RIP** (contains spaces) | **HIGH QUALITY RIP** |
| youtube_video_id | YOUTUBE_VIDEO_ID | same | same |
| youtube_uploaded | YOUTUBE_UPLOADED | same | same |
| gdrive_file_id | GDRIVE_FILE_ID | same | same |
| hqr_release | HQR_RELEASE | same | same |
| rip_game | HQR_GAME | HQR_GAME | HQR_GAME |
| rip_platform | HQR_PLATFORM | HQR_PLATFORM | HQR_PLATFORM |

- ReplayGain (`RG_FIELDS`) uses `REPLAYGAIN_TRACK_GAIN`, `REPLAYGAIN_TRACK_PEAK`, `REPLAYGAIN_ALBUM_GAIN` and `REPLAYGAIN_ALBUM_PEAK` in every container: TXXX for ID3, Vorbis fields, and MP4 freeform.
- Gains are formatted as `"+1.23 dB"` (sign, 2 decimals). Peaks are formatted with 6 decimals.
- **Opus files get REPLAYGAIN_\* too, with no R128_\* tags.** Every real track has ReplayGain.
- Multi-values in single-value containers are joined with `; ` (`MULTI_SEP`). On read, `stringToMulti` splits on `;`, and on `/` when it comes before a UUID.

### 3.3 Ratings, lyrics and dates

- **Rating** is stored in the DB as **stars 0..5**. Writing it:
  ```ts
  const STAR_TO_POPM = [0, 1, 64, 128, 196, 255]
  export function starsToPopm(stars) { return STAR_TO_POPM[Math.max(0, Math.min(5, Math.round(stars)))] }
  export function popmToStars(v) { if (!v) return 0; if (v < 32) return 1; if (v < 96) return 2; if (v < 160) return 3; if (v < 224) return 4; return 5 }
  ```
  Reading it: prefer `POPM:Windows Media Player 9 Series`, then any POPM, else `RATING`. A `RATING` of 5 or less means stars; anything larger is converted with `round(r/20)` and clamped to 1..5.
  - In the real DB every rating is 0.
  - **The phone cannot set ratings without writing tags.**
  - Desktop UI bug: `Stars` shows `round(rating/20)`, which assumes 0..100, while the DB holds 0..5. Smart-rule editors save `stars×20` (§5.4).
- **Lyrics** are synced when the text matches `/^\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/m` (LRC). Otherwise they are plain. Sources are USLT, LYRICS/UNSYNCEDLYRICS, or ©lyr. CRLF is normalized to LF. Real counts: synced 1576, plain 264, none 2533.
- **Dates:**
  - ID3 `TYER`+`TDAT` (both 4 digits) become `YYYY-MM-DD` built from `DDMM`.
  - Otherwise the date is `common.date.slice(0,10)`, falling back to the year.
  - `year = first 4 digits of date ?? originaldate`.

### 3.4 Read precedence the phone should mirror

- Standard fields are read from the container's standard frame or atom, take the first value, and pass through `cleanText`.
- Custom fields are read through a map with **upper-cased** keys:
  - ID3: `TXXX:<desc>` becomes `<DESC>`.
  - Vorbis: every field name.
  - MP4: the `----:<mean>:<name>` atom becomes `<NAME>`.
- The value is `cv(id3Name) ?? cv(vorbisName) ?? cv(mp4Name)`, read **raw** without `cleanText`, and the first value wins.
- Matching is **case-insensitive**. A Vorbis field `valence_id` is accepted.
- `isrc` is upper-cased. Duration comes from the stream. YouTube Opus files may need a full scan to get it.

### 3.5 Tags on rips

YouTube season rips (`src/main/sources/youtube/acquire.ts`):
```ts
const tags: TrackTags = {
  title: info.title,                       // "<track> - <game>"
  artist: 'SiIvaGunner', albumartist: 'SiIvaGunner',
  album,                                   // seasonAlbum(seasonFor(uploaded))
  date: uploaded.slice(0, 10),
  tracknumber: pos.track, totaltracks: pos.total,   // provisional; renumbered later
  composer: desc.composer,                 // "Composer:" line of the description
  rip_game: gameFromTitle(info.title, desc.music),
  rip_platform: desc.platform,             // "Platform:" line
  comment: info.webpage_url ?? url,
  hq_rip: 'YouTube',
  hqr_release: `youtube:${season.key}`,
  youtube_video_id: info.id ?? payload.videoId,
  youtube_uploaded: uploaded,              // ISO time (premiere/upload)
}
// pipeline: if (merged.hq_rip) genre = RIP_GENRE   // 'High Quality Rip'
```

Rip-album and SGFR downloads (`hqrip/acquire.ts`):
- `hq_rip` is `'SiIvaGunner'` or `'SGFR'`.
- `hqr_release` is `hqr:<folderId>` or `sgfr:<id>`.
- `catalognumber` is `SGFR-XXXX` when known, and `gdrive_file_id` is set per track.
- Album and album artist come from the file tags. The defaults are `payload.title` and `'SiIvaGunner Fusion Records'` (SGFR) or `'SiIvaGunner'`.

---

## 4. Rips

### 4.1 Classification (port verbatim)

**A track is a rip if and only if its `HIGH QUALITY RIP` tag is non-empty.** Neither the path nor the genre is used.

```ts
// indexer: hq_rip: t.hq_rip ?? ''      albums: hq_rip = (SELECT max(hq_rip) FROM tracks WHERE album_id = @id)
// src/main/library/queries.ts
export function collectionWhere(alias: string, c: LibraryCollection, kinds?: readonly string[], params?: unknown[]): string | null {
  if (c === 'all') return null
  if (c === 'main') return `${alias}.hq_rip = ''`
  if (kinds?.length && params) {
    params.push(JSON.stringify(kinds))
    return `${alias}.hq_rip IN (SELECT value FROM json_each(?))`
  }
  return `${alias}.hq_rip <> ''`
}
```

Values: `RipCollection = 'SiIvaGunner' | 'SGFR' | 'YouTube'`. Get Info's "High Quality Rip" toggle sets `'SiIvaGunner'` plus the rip genre, and re-files the track under the rip template. Any other non-empty value still counts as a rip, but appears only in Rip Songs.

### 4.2 UI split

- **Main library** (Songs, Albums, Artists, Genres, search, stats library counts, autoplay "similar") uses `hq_rip = ''`.
- **Liked views, playlists and album detail** use `'all'`.
- **Smart playlists exclude rips** unless a rule uses `hqRip`.
- **Listening stats** top lists include rips. The format breakdown counts only the main library.
- **Sidebar group "SiIvaGunner"** (`RipsView.tsx`):

| Tab | Query | Ordering | Card subtitle |
|---|---|---|---|
| Seasons | albums, `collection:'rips', ripKinds:['YouTube']` | season-table order (`seasons.json` or defaults), then `100 + seasonOrder(title)` for unknown titles | `N rips` |
| Rip Albums | albums, `ripKinds:['SiIvaGunner','SGFR']` | Title / Year / Recent (added) | `albumArtist · year` |
| Rip Songs | tracks, `collection:'rips'` (every kind) | user column sort | — |
| Get Rips | desktop-only downloader | — | — |

```ts
/** "Season 4 Episode 2" → 4.5, "Season X" → 10; other titles sort after. */
export function seasonOrder(title: string): number {
  const m = /season\s+(x|\d+)(\s+episode\s+(\d+))?/i.exec(title)
  if (!m) return 1000
  const n = m[1].toLowerCase() === 'x' ? 10 : Number(m[1])
  return n + (m[3] ? Number(m[3]) / 10 : 0)
}
```

- Rip Songs columns: title, **game** (`rip_game`), album, **composer**, time, rating, plays, added. Game and composer are sortable (`ripGame`, `composer`).
- Inside an album, tracks are ordered by `disc_no`, then `track_no`. Season albums are renumbered by upload time.
- If the library has no rips, the view shows an empty state.

### 4.3 Season albums

```ts
export const DEFAULT_SEASONS: SeasonDef[] = [
  { key: 's1', name: 'Season 1', start: '2016-01-09' },
  { key: 's2', name: 'Season 2', start: '2016-10-19' },
  { key: 's3', name: 'Season 3', start: '2018-01-01' },
  { key: 's4', name: 'Season 4', start: '2019-03-26' },
  { key: 's4e2', name: 'Season 4 Episode 2', start: '2020-02-01' },
  { key: 's5', name: 'Season 5', start: '2021-01-04' },
  { key: 's6', name: 'Season 6', start: '2022-01-31' },
  { key: 's7', name: 'Season 7: The Year of Grand Dad', start: '2023-02-01' },
  { key: 's8', name: 'Season 8', start: '2024-01-18' },
  { key: 's9', name: 'Season 9', start: '2025-01-24' },
  { key: 'sx', name: 'Season X', start: '2026-01-07' },
]
/** Album title of a season: "SiIvaGunner: Season 7 – The Year of Grand Dad". */
export function seasonAlbum(s: Pick<SeasonDef, 'name'>): string {
  return `SiIvaGunner: ${s.name.replace(/\s*:\s*/, ' – ')}`
}
/** The season of an upload time (ISO); uploads before Season 1 go to the first season. */
export function seasonFor(uploaded: string, seasons: readonly SeasonDef[]): SeasonDef {
  const day = uploaded.slice(0, 10)
  const sorted = [...seasons].sort((a, b) => a.start.localeCompare(b.start))
  let hit = sorted[0]
  for (const s of sorted) if (s.start <= day) hit = s
  return hit
}
/** The game half of a rip title: what follows the "Music:" track name, else the text after the last " - ". */
export function gameFromTitle(title: string, music?: string): string | undefined {
  const t = title.trim()
  if (music) {
    const m = music.trim()
    if (t.toLowerCase().startsWith(m.toLowerCase())) {
      const rest = t.slice(m.length).replace(/^\s*[-–—]\s*/, '').trim()
      if (rest) return rest
    }
  }
  const i = t.lastIndexOf(' - ')
  return i > 0 ? t.slice(i + 3).trim() || undefined : undefined
}
```

- **On disk:** files follow `RIP_TEMPLATE = 'High Quality Rips/{album}/{title}'`, which gives for example `High Quality Rips/SiIvaGunner - Season 1/3DS Neo Bowser City - Mario Kart 8.opus`.
- **Album tag vs folder name:** the album tag is `SiIvaGunner: Season 1`. `sanitizeComponent` turns `": "` into `" - "`, so the folder is `SiIvaGunner - Season 1`. The en dash in Season 7's name stays.
- **Renumbering:** after imports, the desktop renumbers a season album (`ORDER BY coalesce(youtube_uploaded, date), id`) by **rewriting track and total tags** in the files. The phone will see those files change.
- **Real rip sample:** track 1/30; composer Kenta Nagata; video `wGp7dECyg78`; uploaded `2016-04-15T01:00:01.000Z`; game "Mario Kart 8"; platform "Wii U"; genre "High Quality Rip".

---

## 5. Playlists

Static playlists live in `Playlists/<Name>.m3u8`, the canonical location that other players can read. Smart playlists and mirrors are JSON docs in `.valence/playlists/`. The desktop DB only indexes them.

### 5.1 m3u8 format (port verbatim)

```ts
// src/main/sync/m3u.ts
export function writeM3u(playlistRelPath: string, entries: M3uEntry[]): string {
  const from = posix.dirname(playlistRelPath)
  const lines = ['#EXTM3U']
  for (const e of entries) {
    const dur = e.durationSec !== undefined ? Math.round(e.durationSec) : -1
    if (e.title) lines.push(`#EXTINF:${dur},${e.title.replace(/[\r\n]+/g, ' ')}`)
    lines.push(posix.relative(from, e.relPath))
  }
  return lines.join('\n') + '\n'
}

export function parseM3u(text: string, playlistRelPath: string, libraryRoot?: string): M3uEntry[] {
  const from = posix.dirname(playlistRelPath)
  const out: M3uEntry[] = []
  let pending: { durationSec?: number; title?: string } = {}
  const rootNorm = libraryRoot?.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      const m = /^#EXTINF:(-?\d+(?:\.\d+)?)\s*(?:[^,]*)?,(.*)$/.exec(line)
      if (m) pending = { durationSec: Number(m[1]) >= 0 ? Number(m[1]) : undefined, title: m[2].trim() || undefined }
      continue
    }
    let p = line.replace(/\\/g, '/')
    if (/^file:\/\//i.test(p)) p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, ''))
    let rel: string | null
    if (/^[a-z]:\//i.test(p) || p.startsWith('/')) {
      rel = rootNorm && p.toLowerCase().startsWith(rootNorm + '/') ? p.slice(rootNorm.length + 1) : null
    } else {
      rel = posix.normalize(posix.join(from, p))
      if (rel.startsWith('../')) rel = null
    }
    if (rel) out.push({ relPath: rel, ...pending })
    pending = {}
  }
  return out
}

/** Union merge used when Syncthing produced a conflict copy of a playlist: keep order of `a`, append new items of `b`. */
export function unionMerge(a: M3uEntry[], b: M3uEntry[]): M3uEntry[] {
  const seen = new Set(a.map((e) => e.relPath.toLowerCase()))
  return [...a, ...b.filter((e) => !seen.has(e.relPath.toLowerCase()))]
}
```

The desktop builds entries in `PlaylistStore.writePlaylistFile`:
```ts
const entries = items.map((rel) => {
  const r = db.prepare('SELECT title, artist, duration_ms FROM tracks WHERE rel_path = ?').get(rel)
  return { relPath: rel, title: r ? `${r.artist} - ${r.title}` : undefined, durationSec: r ? r.duration_ms / 1000 : undefined }
})
// written to <abs>.valence-tmp then renamed over <abs>
```

Format details:
- UTF-8, no BOM, LF line endings, a trailing newline, and `#EXTM3U` first.
- Each track is `#EXTINF:<round(sec)>,<artist> - <title>` followed by a path relative to `Playlists/`, for example `../S3RL/The Bass & the Melody (2020)/The Bass & the Melody.mp3`.
- Entries the DB doesn't know are still written, as a bare path line with no EXTINF.
- Duplicates are allowed and kept, except during the conflict union.
- Paths are never URL-encoded.
- Absolute paths are kept only if they fall under the reader's own root. A phone-absolute path `/storage/emulated/0/Music/...` is **dropped by the desktop**, and lost on its next rewrite. **The phone must write relative paths.**

### 5.2 Playlist IDs and docs

```ts
export const PLAYLISTS_DIR = 'Playlists'
function staticId(relPath: string): string {          // relPath = 'Playlists/<file>'
  return 'm3u-' + createHash('sha1').update(foldKey(relPath)).digest('hex').slice(0, 16)
}
// smart: id = `smart-${randomUUID()}`, file `.valence/playlists/smart-<uuid>.json` = {id, name, rules, updatedAt}
// mirror: id = 'mirror-' + sha1(sourceKey).hex.slice(0,16), file `.valence/playlists/<id>.json`
//         = {id, name, sourceKey, tracks: [{tidalTrackId, isrc, artist, title, album, durationMs}], relPath, updatedAt}
// freeName(name): base = sanitizeComponent(name || 'Playlist', 60); `Playlists/${base}${n > 1 ? ` (${n})` : ''}.m3u8`
//                 first n in 1..999 whose foldKey(file) is free; else `${base} ${uuid6}.m3u8`
```

- A static playlist's name is its file name minus `.m3u8?`.
- Its ID is derived from the path, so **renaming creates a new ID**. Rename writes a new file and trashes the old one.

Real mirror doc (`.valence/playlists/mirror-dc250b62ecfa6b02.json`, 33 KB, indent 1):
```json
{
 "id": "mirror-dc250b62ecfa6b02",
 "name": "Hyperpop",
 "sourceKey": "tidal:playlist:375d3e58-64ff-41c8-88ed-526afdcdd947",
 "tracks": [ { "tidalTrackId": "177321809", "isrc": "TCAFB2092742", "artist": "ElyOtto", "title": "SugarCrash!", "album": "SugarCrash!", "durationMs": 80000 }, ... 177 total ],
 "relPath": "Playlists/Hyperpop.m3u8",
 "updatedAt": 1793716082899
}
```

### 5.3 Indexing and conflict merge (`indexAll`)

```ts
const mirrors = this.readDocs<MirrorDoc>('mirror-')               // skips *.sync-conflict-*
const mirrorByPath = new Map(mirrors.map((m) => [foldKey(m.relPath), m]))
const files = readdirSync('Playlists').filter((f) => /\.m3u8?$/i.test(f) && !f.includes('.valence-tmp'))
// Union-merge Syncthing conflict copies into their playlist.
for (const f of files.filter((f) => f.includes('.sync-conflict-'))) {
  const base = f.replace(/\.sync-conflict-[^.]*/, '')
  if (!exists('Playlists/' + base)) continue
  const a = parseM3u(read(base)), b = parseM3u(read(f))
  this.writePlaylistFile(baseRel, unionMerge(a, b).map((e) => e.relPath))
  void this.trash(conflictAbs)                                    // OS trash, not delete
}
for (const f of files.filter((f) => !f.includes('.sync-conflict-'))) {
  const mirror = mirrorByPath.get(foldKey(rel)); const id = mirror?.id ?? staticId(rel)
  upsertRow({ id, name: mirror?.name ?? f.replace(/\.m3u8?$/i, ''), kind: mirror ? 'mirror' : 'static', relPath: rel, sourceKey: mirror?.sourceKey, items })
}
for (const s of this.readDocs<SmartDoc>('smart-')) upsertRow({ id: s.id, name: s.name, kind: 'smart', relPath: null, rules: s.rules, items: [] })
// rows not seen are deleted
```

Conflict semantics:
- Syncthing keeps the newer version as the base file and renames the other to a conflict copy.
- The union keeps the base's order and appends entries that exist only in the conflict copy, compared case-insensitively.
- Consequences:
  1. Concurrent reorders: the base order wins.
  2. A removal on one side plus any edit on the other brings the removed item **back**.
  3. Additions on both sides survive.

### 5.4 Smart playlist rules schema

```ts
export type SmartField =
  | 'title' | 'artist' | 'album' | 'albumArtist' | 'genre' | 'year' | 'rating' | 'playCount' | 'skipCount'
  | 'addedAt' | 'lastPlayed' | 'durationMs' | 'codec' | 'lossless' | 'source' | 'compilation' | 'hqRip' | 'liked'
export type SmartOp = 'is' | 'isNot' | 'contains' | 'notContains' | 'startsWith' | 'gt' | 'lt' | 'between' | 'inLast' | 'notInLast'
export interface SmartRule { field: SmartField; op: SmartOp; value: string | number | boolean; value2?: number }
export interface SmartRules {
  match: 'all' | 'any'
  rules: SmartRule[]
  limit?: number
  sort?: 'random' | 'title' | 'artist' | 'addedAt' | 'lastPlayed' | 'playCount' | 'rating' | 'likedAt'
}
// Boolean fields (lossless, compilation, liked) take op 'is'/'isNot' with a boolean value.

const FIELD_SQL: Record<SmartField, string> = {
  title: 't.title', artist: 't.artist', album: 't.album', albumArtist: 't.album_artist', genre: 't.genre', year: 't.year',
  rating: 't.rating', playCount: 'coalesce(ps.play_count, 0)', skipCount: 'coalesce(ps.skip_count, 0)',
  addedAt: 't.added_at', lastPlayed: 'ps.last_played', durationMs: 't.duration_ms', codec: 't.codec',
  lossless: 't.lossless', source: 't.source', compilation: 't.compilation', hqRip: 't.hq_rip',
  liked: "(SELECT count(*) FROM favorites f WHERE f.kind = 't' AND f.item_key = coalesce(t.valence_id, 'path:' || t.rel_path) AND f.liked = 1)",
}

export function smartSql(rules: SmartRules, now = Date.now()): { sql: string; params: unknown[] } {
  const parts: string[] = []; const params: unknown[] = []
  for (const r of rules.rules) {
    const col = FIELD_SQL[r.field]; if (!col) continue
    const v = typeof r.value === 'boolean' ? (r.value ? 1 : 0) : r.value
    switch (r.op) {
      case 'is': parts.push(typeof v === 'string' ? `${col} = ? COLLATE NOCASE` : `${col} = ?`); params.push(v); break
      case 'isNot': parts.push(typeof v === 'string' ? `coalesce(${col}, '') <> ? COLLATE NOCASE` : `coalesce(${col}, -1) <> ?`); params.push(v); break
      case 'contains': parts.push(`${col} LIKE ?`); params.push(`%${v}%`); break
      case 'notContains': parts.push(`coalesce(${col}, '') NOT LIKE ?`); params.push(`%${v}%`); break
      case 'startsWith': parts.push(`${col} LIKE ?`); params.push(`${v}%`); break
      case 'gt': parts.push(`${col} > ?`); params.push(v); break
      case 'lt': parts.push(`${col} < ?`); params.push(v); break
      case 'between': parts.push(`${col} BETWEEN ? AND ?`); params.push(v, r.value2 ?? v); break
      case 'inLast': parts.push(`${col} > ?`); params.push(now - Number(v) * 86400000); break
      case 'notInLast': parts.push(`(${col} IS NULL OR ${col} <= ?)`); params.push(now - Number(v) * 86400000); break
    }
  }
  const where = parts.length ? parts.join(rules.match === 'any' ? ' OR ' : ' AND ') : '1'
  const order = rules.sort === 'random' ? 'random()'
    : rules.sort === 'addedAt' ? 't.added_at DESC'
    : rules.sort === 'lastPlayed' ? 'ps.last_played DESC'
    : rules.sort === 'playCount' ? 'coalesce(ps.play_count, 0) DESC'
    : rules.sort === 'rating' ? 't.rating DESC'
    : rules.sort === 'likedAt' ? "(SELECT f.at FROM favorites f WHERE f.kind = 't' AND f.item_key = coalesce(t.valence_id, 'path:' || t.rel_path) AND f.liked = 1) DESC"
    : rules.sort === 'title' ? 't.title COLLATE NOCASE'
    : 't.album_artist COLLATE NOCASE, t.year, t.album COLLATE NOCASE, coalesce(t.disc_no, 1), t.track_no'
  // Rips stay out of smart playlists unless a rule asks about them.
  const rips = rules.rules.some((r) => r.field === 'hqRip') ? '' : " AND t.hq_rip = ''"
  const sql = `SELECT t.rel_path FROM tracks t LEFT JOIN play_stats ps ON ps.track_key = coalesce(t.valence_id, 'path:' || t.rel_path)
    WHERE (${where})${rips} ORDER BY ${order}${rules.limit ? ` LIMIT ${Math.floor(rules.limit)}` : ''}`
  return { sql, params }
}
```

Notes for evaluating rules on the phone:
- `inLast` and `notInLast` values are in **days**. `addedAt` and `lastPlayed` are epoch ms.
- `addedAt` is device-local (scan time), so results differ per device.
- **Rating unit bug:** the editor stores rating values ×20 (4 stars becomes `80`), while `t.rating` is 0..5. On the desktop, rating rules therefore never match as intended. Decide on the phone: either follow the desktop (compare raw values) or compare against `rating*20`. The second is recommended, but flag it to the user, because the two devices will then list different tracks.
- No real smart playlists exist yet.

### 5.5 Mirrors

- A mirror is a Tidal playlist reproduced from library tracks. The doc lists the source tracks; `writeMirror` resolves each one to a library rel_path (by tidal ID, ISRC, or artist and title) and writes the m3u8.
- `refreshMirrors()` runs after **every** scan or import that added, updated or removed a file. It rewrites the whole m3u8 when the playlist has fewer resolved items than `doc.tracks.length`.
- That condition is permanently true in the real library: Hyperpop resolves 172 of 177 tracks and Raveee 191 of 223. **Any phone edit to a mirror m3u8 will be overwritten.**
- The phone must show mirrors read-only. A playlist is a mirror when `foldKey(doc.relPath)` equals `foldKey('Playlists/<file>')`.

### 5.6 Desktop operations that rewrite an m3u8

- `create`, `setItems`, `addItems` and `rename` (always a full rewrite; rename also trashes the old file).
- `pathMoved` when a track moves (tag edit, re-file, import upgrade).
- Conflict union (§5.3) and `refreshMirrors`.

Each time, the desktop builds the file from its **DB index** of the playlist. That index is re-read from disk on any watcher event under `Playlists/` (2.5 s debounce). A rewrite by the desktop right after the phone's change has synced is safe. If both write within the Syncthing propagation window, you get a conflict, which §5.3 then resolves.

### 5.7 How the phone can add or reorder items safely

1. Edit only **static** playlists (`Playlists/*.m3u8` that is not a mirror).
2. Immediately before writing, **re-read the file from disk** and parse it with a port of `parseM3u`, using the phone root. Never write from a stale in-memory copy.
3. Apply the change:
   - **Add:** append. Avoid duplicates unless the user wants them; the desktop allows them.
   - **Reorder:** move.
   - **Remove:** delete the entry. Removals can come back after a conflict (§5.3).
4. **Keep entries the phone can't resolve** (for example files not synced yet) exactly as they are. The desktop keeps them too. Dropping them would delete them for everyone.
5. Serialize with a port of `writeM3u`:
   - Title is `"${artist} - ${title}"` and duration is `round(duration_ms/1000)` when the track is known; otherwise write the path line only.
   - Paths are relative to `Playlists/`. Since playlists only live there, that is `"../" + relPath`, but port `posix.relative` in general.
   - Write LF line endings, no BOM, and a trailing newline.
6. Write atomically: `Playlists/<Name>.m3u8.valence-tmp`, then rename over the original.
7. Coalesce edits so one write covers a burst of changes. That keeps the Syncthing conflict window small.
8. **New playlist:** use the `freeName` rules (`sanitizeComponent(name, 60)`, ` (n)` suffix, case-insensitive uniqueness). The ID becomes `staticId('Playlists/<file>')`.
9. **Rename:** write the new file, then delete the old one. This is the desktop's behavior, and the ID changes.
10. **Delete:** remove the file. Expect it to come back if another device edits it concurrently.
11. **Conflict copies:** do **not** merge or delete `*.sync-conflict-*` m3u8 files from the phone. Show the union read-only and let the desktop resolve them. Two resolvers racing each other create new conflicts.

Smart docs from the phone (optional):
- Write `smart-<uuid>.json` containing `{id:"smart-<uuid>", name, rules, updatedAt}`, indent 1, via `.valence-tmp`.
- When reading, **deduplicate by `id`** and keep the newest `updatedAt`, because of the desktop rename bug (§5.8).
- To delete, remove both `smart-<uuid>.json` and `smart-smart-<uuid>.json` if present.

### 5.8 Desktop playlist bugs that affect the phone

1. **Smart rename** writes `smart-${id}.json` where `id` is already `smart-<uuid>`. The result is a duplicate doc, `smart-smart-<uuid>.json`, with the same `id` and the new name. Which one wins on the next index depends on directory order.
2. **Delete of a smart playlist or mirror** trashes `smart-${id}.json` or `mirror-${id}.json`, which become `smart-smart-…` or `mirror-mirror-…` and don't exist. The real doc stays:
   - A smart playlist comes back on the next `indexAll`.
   - A mirror's m3u8 is recreated by `refreshMirrors`.
3. **Mirror rename** turns it into a static playlist under a new file, but the mirror doc still points at the old `relPath`. `refreshMirrors` then recreates the old file, so you end up with two playlists.
4. **Smart-doc conflict copies** are ignored forever. They are neither merged nor removed.

---

## 6. Plays and stats

### 6.1 Play and skip thresholds (port verbatim)

```ts
// src/renderer/audio/player.ts
private beginListen(item: PlayItem, startMs: number): void {
  this.listen = { item, startedAt: Date.now(), playedMs: 0, lastPos: startMs }
}
private trackPlayed(pos: number): void {          // called on every position update
  const l = this.listen; if (!l) return
  const d = pos - l.lastPos
  if (this.playing && d > 0 && d < 1500) l.playedMs += d      // seeks and stalls don't count
  l.lastPos = pos
}
private endListen(reason: 'completed' | 'skipped' | 'stopped'): void {
  const l = this.listen; this.listen = null; if (!l) return
  const dur = l.item.durationMs > 0 ? l.item.durationMs : this.dur
  const threshold = dur > 0 ? Math.min(dur * 0.5, 240_000) : 240_000
  const playedMs = Math.round(l.playedMs)
  if (playedMs >= threshold) {
    // PLAY: recordPlay({ playedAt: l.startedAt, ms: playedMs, completed: reason === 'completed', skipped: false })
  } else if (reason === 'skipped' && playedMs < 30_000) {
    // SKIP: recordPlay({ playedAt: l.startedAt, ms: playedMs, completed: false, skipped: true })
  }
  // else (stopped early, or skipped after 30 s but before the threshold): nothing is logged
}
```

The rules:
- A **play** is counted when listened time reaches at least half the track or 4 minutes, whichever is smaller. If the duration is unknown, the threshold is 4 minutes.
- A **skip** is a user skip (next, previous, picking another track, and so on) that happens before 30 s of listening.
- Reasons:
  - `completed` means the track ended naturally.
  - `stopped` means the page was hidden or closed, playback was stopped, or the player was torn down. A track that is paused and then replaced counts as `stopped`.
  - Everything else is `skipped`.

Real data supports this: plays always have `ms ≥ min(dur/2, 240000)`, and every skip has `ms < 30000`. Some short completed tracks counted as plays at about 6.6 s.

### 6.2 What Android must log

Use exactly `{hlc, k, at, ms, c, s}`, appended to `devices/<phoneId>/plays-<UTC yyyy-MM of at>.jsonl`:
- `k` = `valenceId ?? "path:" + relPath` of the row that was playing.
- `at` = wall-clock epoch ms when the listen **started**.
- `ms` = accumulated listened ms using the same 1500 ms delta rule.
- `c` = 1 only for natural completion.
- `s` = 1 for qualifying skips. Never set `c` and `s` together.
- Log on the same transitions.
- Android-specific cases: on `onTaskRemoved`, process death or service stop, treat the end as `stopped`, and persist the in-progress listen so it can be logged on the next start. Don't log twice: use a durable "pending listen" record.
- Don't add fields. Unknown fields are harmless to the desktop, but they don't round-trip anywhere.

### 6.3 `play_stats` and listening stats

```sql
CREATE VIEW play_stats AS
  SELECT track_key,
         sum(CASE WHEN skipped = 0 THEN 1 ELSE 0 END) AS play_count,
         sum(skipped) AS skip_count,
         max(CASE WHEN skipped = 0 THEN played_at END) AS last_played
  FROM plays GROUP BY track_key;
```

- Track rows join it on `coalesce(valence_id, 'path:' || rel_path)`.
- `ListeningStats`:
  - `plays` counts non-skips; `ms` sums every row, skips included.
  - Ranges `7d`, `30d` and `90d` are calendar days including today (local time); `year` is the last 365 days.
  - `byDay` and `byHour` are local time; `byWeekday` starts at Monday = 0.
  - Top artists are by album artist (the track artist on VA compilations).
- Real DB: 257 plays, of which 170 are skips. 72 come from aaaaa and 185 from bbbbb. 0 are path-keyed, and 3 are orphans (their track key matches no current track).

### 6.4 Loudness (for consistent volume with the desktop)

```ts
export function rgGain(item, mode: 'off'|'track'|'album'|'auto', albumContext: boolean): number {
  const rg = item?.rg; if (!rg || mode === 'off') return 1
  const album = mode === 'album' || (mode === 'auto' && albumContext)
  const gain = album ? (rg.albumGain ?? rg.trackGain) : (rg.trackGain ?? rg.albumGain)
  const peak = album ? (rg.albumPeak ?? rg.trackPeak) : (rg.trackPeak ?? rg.albumPeak)
  if (gain === undefined || !Number.isFinite(gain)) return 1
  let g = 10 ** (clamp(gain, -24, 24) / 20)
  if (peak && peak > 0) g = Math.min(g, 1 / peak)
  return g
}
```

- Apply `REPLAYGAIN_*` tags as they are, Opus included. ExoPlayer won't do it for you.
- `albumContext` means the next track directly continues the same album (`isAlbumContinuation`).
- The desktop's preamp is clamped to -12..+12 dB.

---

## 7. Library layout rules and `.stignore`

### 7.1 Layout

- Default template: `DEFAULT_TEMPLATE = '{albumartist_primary}/{album}[ ({year})]/{title}'`, followed by the extension. Rips use `RIP_TEMPLATE = 'High Quality Rips/{album}/{title}'`.
  - A compilation's album artist is "Various Artists".
  - An album-less track is filed with album = title.
  - `year = /^(\d{4})/` of date, falling back to originaldate.
  - There is no track number in the file name.
- Every component goes through `sanitizeComponent`:
  ```ts
  s = cleanText(input)
    .replace(/\s*:\s+/g, ' - ').replace(/:/g, '-').replace(/[/\\]/g, '-').replace(/[?*]/g, '')
    .replace(/"/g, "'").replace(/[<>|]/g, '_').replace(/\s+/g, ' ').trim()
  s = s.replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(s)) s = `_${s}`
  s = truncateGraphemes(s, maxLen /* 80 */).replace(/[. ]+$/, '');  return s || '_'
  ```
  `MAX_REL_PATH` is 180.
- Name collisions get suffixes in this order: ` (Disc N)` when totaldiscs > 1, then ` (<track artist>)`, then ` (2)` through ` (99)`. Existing folder casing is reused.
- Reserved top-level names (compared with `foldKey`): `playlists`, `.valence`, `music`, `itunes`, `garageband`, `audio music apps`, `logic`, `podcasts`, `android`, `lost.dir`. An artist folder that would collide gets ` (Artist)` appended.

### 7.2 What the scanner indexes (port for the phone walk)

```ts
export function shouldSkipDir(name: string, depth: number): boolean {
  if (name.startsWith('.')) return true
  if (isIgnoredName(name)) return true
  return depth === 0 && isReservedTopLevel(name)
}
// walk: at depth 0 a dir named (case-insensitively) 'playlists' is only scanned for /\.m3u8?$/i files;
// files: conflict copies of audio are reported separately and not indexed;
//        skip isIgnoredName(name) || name.startsWith('.') || !AUDIO_EXTENSIONS.has(ext)
export function isIgnoredName(name: string): boolean {
  const n = name.toLowerCase()
  return n.includes('.sync-conflict-') || n.endsWith('.valence-tmp') || n.startsWith('~syncthing~') || n.startsWith('.syncthing.')
    || n === '.stfolder' || n === '.stversions' || n === '.stignore' || n === '.trashed' || n.startsWith('._')
    || n === 'desktop.ini' || n === 'thumbs.db' || n === '.ds_store'
}
// AUDIO_EXTENSIONS: mp3 flac m4a mp4 aac alac ogg oga opus wav aif aiff aifc wma ape wv tta mpc mp2 ac3 dsf dff webm mka
```

- Files at the root are indexed too.
- Android's MediaStore trash (`.trashed-…`) and `.stfolder.removed-*` are both skipped by the leading-dot rule.

### 7.3 `.stignore` managed block

`.stignore` is per device and not synced. The desktop keeps this block current on every start and preserves the user's lines outside it.

```ts
const BEGIN = '// BEGIN Valence (managed — edits inside this block are overwritten)'   // U+2014 em dash
const END = '// END Valence'
export const STIGNORE_LINES = ['*.valence-tmp', '(?d).DS_Store', '(?d)._*', '(?d)Thumbs.db', '(?d)desktop.ini',
  '(?d).thumbnails', '(?d).Trashes', '(?d).Spotlight-V100', '(?d).fseventsd',
  '/Music', '/iTunes', '/GarageBand', '/Audio Music Apps', '/Logic']
export function renderStignore(existing: string, lines = STIGNORE_LINES): string {
  const block = [BEGIN, ...lines, END].join('\n')
  const start = existing.indexOf(BEGIN)
  const end = existing.indexOf(END)
  if (start >= 0 && end > start) return existing.slice(0, start) + block + existing.slice(end + END.length)
  const sep = existing && !existing.endsWith('\n') ? '\n' : ''
  return `${existing}${sep}${existing ? '\n' : ''}${block}\n`
}
```

The real `.stignore` is exactly the block plus `\n` (268 bytes). **Phone:** apply the same `renderStignore` to `/storage/emulated/0/Music/.stignore`, which is read by the phone's own Syncthing. If the phone has no access to that file, ask the user to add `*.valence-tmp` themselves.

---

## 9. Risks for the phone

1. **Never write audio.** That rules out ratings (POPM/RATING tags), VALENCE_ID assignment and repair, tag edits, and Get Info's rip toggle on the phone. Path-keyed tracks stay path-keyed until a desktop adopts them.
2. **Single writer per folder.** Write only `devices/<phoneId>/`, append-only, whole lines. Keep the device ID out of backups.
3. **Album and artist like keys depend on porting `foldKey`, `matchKey` and `cleanText` exactly** (ASCII `\b`, Unicode `\s`), and on reading the same album and title values. Test them against the real DB's `albums.album_key`. With 608 albums available, a read-only export makes a good fixture.
4. **Path keys and playlist entries are byte-exact** (case and NFC). Android filesystems are case-sensitive and Windows isn't. If folder casing differs between devices, entries and `path:` keys won't match.
5. **Playlists:**
   - Writes are whole-file, and conflicts are resolved by union, so deletions can resurrect.
   - Mirrors are desktop-owned and constantly rewritten.
   - Don't resolve conflict copies on the phone.
   - Smart docs can be duplicated by the rename bug; deduplicate by `id`.
6. **Play rekeys are local-only** on the desktop (§2.7). Rare in practice, since every track has an ID.
7. **Clock:** a phone clock far ahead poisons favorites LWW for every device. Persist and observe HLCs, and consider capping future skew.
8. **Monthly plays files use UTC.** Name them from `at`, not from "now".
9. **Ignore** `~syncthing~*`, `.syncthing.*`, `*.sync-conflict-*` and `*.valence-tmp` everywhere.
10. **`settings.json` holds an AcoustID API key in plain text.** Treat it as read-only and never log it.
11. **`gameFromTitle`** falls back to the text after the last ` - ` when the description has no `Music:` line. That gives a wrong game for titles like "Ground Theme - Super Mario Bros. - …". `rip_game` is a desktop-computed tag, so just display it.
12. **Android storage access:** reading `.valence/*.json(l)` and writing logs and m3u8 files under `Music/` needs All-files access (`MANAGE_EXTERNAL_STORAGE`) or a SAF tree grant on `Music/`. MediaStore can't see non-media files the app doesn't own. With SAF, appends use `"wa"` mode.
13. **Sync latency:** the phone's Syncthing must use folder type "Send & Receive". Android file watching is unreliable, so logs may wait for the next rescan. Optionally ask Syncthing to rescan `.valence/devices/<phoneId>` through its REST API after writing.
