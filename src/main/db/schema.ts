// Local index database (never synced; rebuildable from a scan of the library). Each entry is one
// migration, applied in order and recorded in PRAGMA user_version.

export const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE albums (
    id INTEGER PRIMARY KEY,
    album_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    album_artist TEXT NOT NULL,
    year INTEGER,
    genre TEXT,
    track_total INTEGER,
    disc_total INTEGER,
    compilation INTEGER NOT NULL DEFAULT 0,
    art_hash TEXT,
    rel_dir TEXT NOT NULL,
    mb_release_id TEXT,
    tidal_album_id TEXT,
    bandcamp_item_id TEXT,
    barcode TEXT,
    match_title TEXT NOT NULL DEFAULT '',
    match_artist TEXT NOT NULL DEFAULT '',
    added_at INTEGER NOT NULL
  );
  CREATE INDEX albums_artist ON albums(album_artist COLLATE NOCASE);
  CREATE INDEX albums_tidal ON albums(tidal_album_id);
  CREATE INDEX albums_bandcamp ON albums(bandcamp_item_id);
  CREATE INDEX albums_barcode ON albums(barcode);
  CREATE INDEX albums_match ON albums(match_artist, match_title);
  CREATE INDEX albums_match_title ON albums(match_title);

  CREATE TABLE tracks (
    id INTEGER PRIMARY KEY,
    valence_id TEXT,
    rel_path TEXT NOT NULL UNIQUE,
    path_key TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    container TEXT,
    codec TEXT,
    bitrate INTEGER NOT NULL DEFAULT 0,
    sample_rate INTEGER NOT NULL DEFAULT 0,
    bit_depth INTEGER NOT NULL DEFAULT 0,
    channels INTEGER NOT NULL DEFAULT 0,
    lossless INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    artists_json TEXT,
    album TEXT NOT NULL DEFAULT '',
    album_artist TEXT NOT NULL DEFAULT '',
    artist_sort TEXT,
    album_artist_sort TEXT,
    title_sort TEXT,
    album_sort TEXT,
    track_no INTEGER,
    track_total INTEGER,
    disc_no INTEGER,
    disc_total INTEGER,
    date TEXT,
    original_date TEXT,
    year INTEGER,
    genre TEXT,
    compilation INTEGER NOT NULL DEFAULT 0,
    explicit INTEGER NOT NULL DEFAULT 0,
    isrc TEXT,
    barcode TEXT,
    label TEXT,
    catalog_no TEXT,
    copyright TEXT,
    bpm INTEGER,
    music_key TEXT,
    comment TEXT,
    mb_recording_id TEXT,
    mb_track_id TEXT,
    mb_release_id TEXT,
    mb_release_group_id TEXT,
    mb_artist_id TEXT,
    mb_albumartist_id TEXT,
    acoustid_id TEXT,
    tidal_track_id TEXT,
    tidal_album_id TEXT,
    bandcamp_item_id TEXT,
    bandcamp_track_id TEXT,
    bandcamp_url TEXT,
    source TEXT,
    source_quality TEXT,
    owner_device TEXT,
    rating INTEGER NOT NULL DEFAULT 0,
    rg_track_gain REAL,
    rg_track_peak REAL,
    rg_album_gain REAL,
    rg_album_peak REAL,
    lyrics_kind TEXT NOT NULL DEFAULT 'none',
    art_hash TEXT,
    album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL,
    match_title TEXT NOT NULL DEFAULT '',
    match_artist TEXT NOT NULL DEFAULT '',
    added_at INTEGER NOT NULL,
    scanned_at INTEGER NOT NULL
  );
  CREATE INDEX tracks_path_key ON tracks(path_key);
  CREATE INDEX tracks_valence ON tracks(valence_id);
  CREATE INDEX tracks_album ON tracks(album_id);
  CREATE INDEX tracks_album_artist ON tracks(album_artist COLLATE NOCASE);
  CREATE INDEX tracks_artist ON tracks(artist COLLATE NOCASE);
  CREATE INDEX tracks_genre ON tracks(genre COLLATE NOCASE);
  CREATE INDEX tracks_isrc ON tracks(isrc);
  CREATE INDEX tracks_tidal ON tracks(tidal_track_id);
  CREATE INDEX tracks_tidal_album ON tracks(tidal_album_id);
  CREATE INDEX tracks_bandcamp ON tracks(bandcamp_track_id);
  CREATE INDEX tracks_bandcamp_item ON tracks(bandcamp_item_id);
  CREATE INDEX tracks_mb_recording ON tracks(mb_recording_id);
  CREATE INDEX tracks_mb_release ON tracks(mb_release_id);
  CREATE INDEX tracks_match ON tracks(match_artist, match_title);
  CREATE INDEX tracks_match_title ON tracks(match_title);
  CREATE INDEX tracks_added ON tracks(added_at);

  CREATE VIRTUAL TABLE tracks_fts USING fts5(
    title, artist, album, album_artist, genre,
    content='tracks', content_rowid='id', tokenize='unicode61 remove_diacritics 2', prefix='2 3'
  );
  CREATE TRIGGER tracks_ai AFTER INSERT ON tracks BEGIN
    INSERT INTO tracks_fts(rowid, title, artist, album, album_artist, genre)
    VALUES (new.id, new.title, new.artist, new.album, new.album_artist, coalesce(new.genre, ''));
  END;
  CREATE TRIGGER tracks_ad AFTER DELETE ON tracks BEGIN
    INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, album_artist, genre)
    VALUES ('delete', old.id, old.title, old.artist, old.album, old.album_artist, coalesce(old.genre, ''));
  END;
  CREATE TRIGGER tracks_au AFTER UPDATE OF title, artist, album, album_artist, genre ON tracks BEGIN
    INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, album_artist, genre)
    VALUES ('delete', old.id, old.title, old.artist, old.album, old.album_artist, coalesce(old.genre, ''));
    INSERT INTO tracks_fts(rowid, title, artist, album, album_artist, genre)
    VALUES (new.id, new.title, new.artist, new.album, new.album_artist, coalesce(new.genre, ''));
  END;

  -- Materialized from every device's synced play logs.
  CREATE TABLE plays (
    device_id TEXT NOT NULL,
    hlc TEXT NOT NULL,
    track_key TEXT NOT NULL,
    played_at INTEGER NOT NULL,
    ms INTEGER NOT NULL,
    completed INTEGER NOT NULL,
    skipped INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, hlc)
  );
  CREATE INDEX plays_track ON plays(track_key);
  CREATE VIEW play_stats AS
    SELECT track_key,
      sum(CASE WHEN skipped = 0 THEN 1 ELSE 0 END) AS play_count,
      sum(skipped) AS skip_count,
      max(CASE WHEN skipped = 0 THEN played_at END) AS last_played
    FROM plays GROUP BY track_key;

  CREATE TABLE playlists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    m3u_rel_path TEXT,
    rules_json TEXT,
    source_key TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE playlist_items (
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    pos INTEGER NOT NULL,
    rel_path TEXT NOT NULL,
    PRIMARY KEY (playlist_id, pos)
  );

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    release_keys TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT,
    progress REAL,
    message TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    report_id TEXT,
    review_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX jobs_status ON jobs(status);

  CREATE TABLE import_reports (
    id TEXT PRIMARY KEY,
    job_id TEXT,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    summary_json TEXT NOT NULL,
    undone_at INTEGER
  );
  CREATE TABLE import_actions (
    id INTEGER PRIMARY KEY,
    report_id TEXT NOT NULL REFERENCES import_reports(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    rel_path TEXT,
    detail_json TEXT,
    undo_json TEXT
  );
  CREATE INDEX import_actions_report ON import_actions(report_id);

  CREATE TABLE log_cursors (
    file TEXT PRIMARY KEY,
    offset INTEGER NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL
  );

  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
]
