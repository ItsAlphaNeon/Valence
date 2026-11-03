// Import-pipeline settings: transcoding, artwork and metadata.

import { Card, CommitInput, ExternalLink, Row, SectionHead, Select, StackRow, TextSetting, ToggleRow, useSettingValue } from '../controls'

// Mirrors PROFILES in src/main/media/transcode.ts (main-only module; it pulls in ffmpeg).
type ProfileId = 'mp3-320' | 'mp3-v0' | 'aac-256' | 'opus-192' | 'flac'
const PROFILES: Array<{ value: ProfileId; label: string; desc: string }> = [
  { value: 'mp3-320', label: 'MP3 320 kbps CBR', desc: 'Plays everywhere — car stereos, old players, every phone. The default.' },
  { value: 'mp3-v0', label: 'MP3 V0 (VBR ~245 kbps)', desc: 'Transparent for nearly everyone at about three quarters the size of 320.' },
  { value: 'aac-256', label: 'AAC 256 kbps (M4A)', desc: 'iTunes-style quality; great on Apple devices.' },
  { value: 'opus-192', label: 'Opus 192 kbps', desc: 'The most efficient codec here; not every car or older device plays it.' },
  { value: 'flac', label: 'FLAC (keep lossless)', desc: 'No transcode — the library keeps lossless files. Needs a lot more space.' },
]

export function TranscodingSection() {
  const [profile, setProfile] = useSettingValue<ProfileId>('transcode.profile', 'mp3-320')
  const cur = PROFILES.find((p) => p.value === profile) ?? PROFILES[0]
  return (
    <>
      <SectionHead icon="wave" title="Transcoding">
        Lossless sources are encoded once for the library; their FLAC master goes to the Archive. Lossy files are never re-encoded to another lossy format.
      </SectionHead>
      <Card title="Library format">
        <Row label="Encode lossless imports as" desc={cur.desc}>
          <Select value={cur.value} options={PROFILES} onChange={setProfile} ariaLabel="Library format" />
        </Row>
        <Row
          label="Lossy imports"
          desc="MP3, AAC, Opus and Vorbis files are kept bit-for-bit. Other lossy formats (WMA and friends) become MP3 320."
        />
      </Card>
      <Card title="Loudness">
        <ToggleRow
          k="import.replaygain"
          fallback={true}
          label="Measure ReplayGain"
          desc="Analyze each track’s loudness (EBU R128) on import and write track and album ReplayGain tags, so playback can level volume without touching the audio."
        />
      </Card>
      <p className="set-footnote">Changing the format affects future imports only. Existing files stay as they are.</p>
    </>
  )
}

export function ArtworkSection() {
  const [max, setMax] = useSettingValue<number>('art.maxSize', 2000)
  return (
    <>
      <SectionHead icon="albums" title="Artwork">
        Valence picks the best cover from the source, the Cover Art Archive and embedded art, then embeds a right-sized copy in every file.
      </SectionHead>
      <Card title="Embedded covers">
        <Row label="Maximum size" desc="Larger covers are scaled down (longest side, in pixels) before being embedded. Smaller files, faster browsing.">
          <span className="row">
            <CommitInput
              type="number"
              width={96}
              value={String(max)}
              ariaLabel="Maximum cover size in pixels"
              validate={(v) => {
                const n = Number(v)
                if (!Number.isFinite(n) || !Number.isInteger(n)) return 'Enter a whole number of pixels.'
                if (n < 300 || n > 10000) return 'Choose a size between 300 and 10,000 pixels.'
                return null
              }}
              onCommit={(v) => setMax(Number(v))}
            />
            <span className="faint">px</span>
          </span>
        </Row>
        <ToggleRow
          k="art.archiveOriginals"
          fallback={true}
          label="Keep original covers"
          desc="Save the full-resolution cover next to the album’s masters in the Archive (as cover-original). Covers that had to be scaled down are always kept."
        />
      </Card>
    </>
  )
}

export function MetadataSection() {
  const [mb] = useSettingValue<boolean>('metadata.musicbrainz', true)
  return (
    <>
      <SectionHead icon="tag" title="Metadata">
        Valence matches imports against MusicBrainz for clean, consistent tags — release dates, album artists, track numbers and genres.
      </SectionHead>
      <Card title="MusicBrainz">
        <ToggleRow
          k="metadata.musicbrainz"
          fallback={true}
          label="Identify releases"
          desc="Look up each import on MusicBrainz. Confident matches are applied automatically; uncertain ones wait in Needs Review."
        />
        <StackRow
          label="Contact for MusicBrainz"
          desc="MusicBrainz asks apps to include a way to reach the user in their requests. Optional — an email address or a web page of yours."
          className={mb ? undefined : 'set-dim'}
        >
          <TextSetting k="metadata.mbContact" placeholder="Email address or website URL" ariaLabel="MusicBrainz contact" width="100%" />
        </StackRow>
      </Card>
      <Card title="AcoustID">
        <StackRow
          label="AcoustID API key"
          desc={
            <>
              Identifies files by their sound when tags are missing or wrong. Get a free key at <ExternalLink href="https://acoustid.org/new-application" />, then paste it here. Leave empty to
              turn fingerprinting off.
            </>
          }
        >
          <TextSetting k="metadata.acoustidKey" emptyValue={null} placeholder="Paste your application API key" mono ariaLabel="AcoustID API key" width="100%" />
        </StackRow>
      </Card>
      <Card title="Lyrics">
        <ToggleRow
          k="lyrics.fetch"
          fallback={true}
          label="Fetch lyrics"
          desc="Look up synced (or plain) lyrics on LRCLIB during import and save them in the file’s tags."
          note={mb ? undefined : 'Lyrics are fetched only while Identify releases is on.'}
        />
      </Card>
    </>
  )
}
