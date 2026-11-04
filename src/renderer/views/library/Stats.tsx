// Listening Stats: how much you listened, when, and to what, plus what's in the library.

import { LIB, type ListeningStats, type StatsRange } from '@shared/ipc/library'
import { invoke } from '../../lib/ipc'
import { bytes, cx, longDuration, plural } from '../../lib/format'
import { useLibData } from '../../state/library'
import { albumRoute, navigate } from '../../state/ui'
import { useViewHeader } from '../../shell/header'
import { AlbumTile } from '../../components/AlbumGrid'
import { Shelf } from '../../components/Hero'
import { TrackTable } from '../../components/TrackTable'
import { ColumnChart, Meter, StatTile, compact, type Datum } from '../../components/Charts'
import { Artwork, Empty, Spinner } from '../../components/ui'

const RANGES: Array<{ id: StatsRange; label: string; long: string }> = [
  { id: '7d', label: '7 days', long: 'the last 7 days' },
  { id: '30d', label: '30 days', long: 'the last 30 days' },
  { id: '90d', label: '90 days', long: 'the last 90 days' },
  { id: 'year', label: 'Year', long: 'the last 12 months' },
  { id: 'all', label: 'All time', long: 'all time' },
]
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function hourLabel(h: number): string {
  return new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })
}
function minutes(ms: number): string {
  const m = Math.round(ms / 60_000)
  return m < 60 ? plural(m, 'minute') : `${Math.floor(m / 60)} h ${m % 60} min`
}
const day = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function HeroTime({ ms }: { ms: number }) {
  const total = Math.round(ms / 60_000)
  const h = Math.floor(total / 60)
  const m = total % 60
  return (
    <span className="stats-hero-figure">
      {h > 0 && (
        <>
          <b>{h.toLocaleString()}</b>
          <i>{h === 1 ? 'hour' : 'hours'}</i>
        </>
      )}
      <b>{m}</b>
      <i>{m === 1 ? 'minute' : 'minutes'}</i>
    </span>
  )
}

export function StatsView({ range = '30d' }: { range?: StatsRange }) {
  const { data, loading } = useLibData(() => invoke<ListeningStats>(LIB.listeningStats, range), [range])
  useViewHeader({ color: null, title: 'Listening stats' })
  const meta = RANGES.find((r) => r.id === range) ?? RANGES[1]

  const daily: Datum[] = (data?.byDay ?? []).map((d) => ({
    label: day(d.day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: range === 'all' || range === 'year' ? 'numeric' : undefined }),
    value: d.plays,
    detail: d.ms ? minutes(d.ms) : undefined,
  }))
  const dayN = daily.length
  const dayLabel = (_: Datum, i: number): string | null => {
    const dt = day(data!.byDay[i].day)
    if (dayN <= 10) return dt.toLocaleDateString(undefined, { weekday: 'short' })
    if (dayN <= 45) return i % 7 === (dayN - 1) % 7 ? dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null
    return dt.getDate() === 1 ? dt.toLocaleDateString(undefined, { month: 'short' }) : null
  }
  const hourly: Datum[] = (data?.byHour ?? []).map((v, h) => ({ label: `${hourLabel(h)}–${hourLabel((h + 1) % 24)}`, value: v }))
  const weekly: Datum[] = (data?.byWeekday ?? []).map((v, i) => ({ label: WEEKDAYS[i], value: v }))
  const peakHour = data ? data.byHour.indexOf(Math.max(...data.byHour)) : -1
  const peakDay = data ? data.byWeekday.indexOf(Math.max(...data.byWeekday)) : -1
  const empty = data && data.plays === 0 && data.skips === 0
  const topArtistMax = data?.topArtists[0]?.plays ?? 0
  const formatMax = data?.formats[0]?.tracks ?? 0
  const lib = data?.library

  return (
    <div className="view stats">
      <div className="view-head">
        <div>
          <h1 className="view-title">Listening stats</h1>
          <div className="view-sub">
            {data?.firstPlay ? `Listening since ${new Date(data.firstPlay).toLocaleDateString(undefined, { dateStyle: 'medium' })}` : `Your listening over ${meta.long}`}
          </div>
        </div>
      </div>
      <div className="pill-row" role="tablist" aria-label="Time range">
        {RANGES.map((r) => (
          <button key={r.id} role="tab" aria-selected={r.id === range} className={cx('pill', r.id === range && 'on')} onClick={() => navigate({ view: 'stats', range: r.id })}>
            {r.label}
          </button>
        ))}
      </div>
      {!data ? (
        <div className="center-spin">
          <Spinner />
        </div>
      ) : (
        <div className={cx('stats-body', loading && 'refetching')}>
          {empty ? (
            <Empty icon="chart" title={`Nothing played in ${meta.long}`}>
              Songs count once you've listened to half of them (or four minutes). Pick a longer range or start playing.
            </Empty>
          ) : (
            <>
              <section className="stats-hero">
                <span className="stat-label">Time listened</span>
                <HeroTime ms={data.ms} />
                <div className="stat-tiles">
                  <StatTile label="Plays" value={compact(data.plays)} sub={data.skips ? `${plural(data.skips, 'skip')} · ${Math.round((data.skips / (data.plays + data.skips)) * 100)}% skipped` : 'No skips'} />
                  <StatTile label="Different songs" value={compact(data.distinctTracks)} />
                  <StatTile label="Artists" value={compact(data.distinctArtists)} />
                  {peakHour >= 0 && data.byHour[peakHour] > 0 && <StatTile label="Favorite hour" value={hourLabel(peakHour)} sub={`${WEEKDAYS[peakDay]}s are your busiest day`} />}
                </div>
              </section>

              {daily.length > 1 && (
                <section className="card chart-card">
                  <h2 className="card-title">Plays per day</h2>
                  <ColumnChart data={daily} unit="plays" title="Plays per day" xLabel={dayLabel} />
                </section>
              )}
              <div className="chart-pair">
                <section className="card chart-card">
                  <h2 className="card-title">Time of day</h2>
                  <ColumnChart data={hourly} unit="plays" title="Plays by hour of day" height={150} xLabel={(_, i) => (i % 6 === 0 ? hourLabel(i) : null)} />
                </section>
                <section className="card chart-card">
                  <h2 className="card-title">Day of week</h2>
                  <ColumnChart data={weekly} unit="plays" title="Plays by day of week" height={150} />
                </section>
              </div>

              {data.topTracks.length > 0 && (
                <section className="section">
                  <h2 className="section-title">Top songs</h2>
                  <TrackTable rows={data.topTracks.slice(0, 10)} columns={['index', 'title', 'album', 'heart', 'plays', 'time']} source={{ kind: 'other', id: `stats:${range}`, title: 'Top songs' }} showArt />
                </section>
              )}
              {data.topArtists.length > 0 && (
                <section className="section">
                  <h2 className="section-title">Top artists</h2>
                  <ol className="rank-list">
                    {data.topArtists.slice(0, 10).map((a, i) => (
                      <li key={a.name} className="rank-row" onClick={() => navigate({ view: 'artist', artist: a.name })}>
                        <span className="rank-n">{i + 1}</span>
                        <Artwork hash={a.artHash} px={96} size={40} className="round" title={a.name} />
                        <span className="rank-name ellipsis">{a.name}</span>
                        <Meter value={a.plays} max={topArtistMax} />
                        <span className="rank-val">
                          <b>{plural(a.plays, 'play')}</b>
                          <span className="faint">{minutes(a.ms)}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              {data.topAlbums.length > 0 && (
                <Shelf title="Top albums">
                  {data.topAlbums.slice(0, 12).map((a) => (
                    <AlbumTile key={a.id} a={a} sub={plural(a.plays, 'play')} />
                  ))}
                </Shelf>
              )}
            </>
          )}

          {lib && (
            <section className="section">
              <h2 className="section-title">Your library</h2>
              <div className="stat-tiles">
                <StatTile label="Songs" value={compact(lib.tracks)} sub={lib.ripTracks ? `+ ${compact(lib.ripTracks)} rips` : undefined} />
                <StatTile label="Albums" value={compact(lib.albums)} sub={lib.ripAlbums ? `+ ${compact(lib.ripAlbums)} rip albums` : undefined} />
                <StatTile label="Artists" value={compact(lib.artists)} />
                <StatTile label="Playing time" value={longDuration(lib.durationMs)} />
                <StatTile label="On disk" value={bytes(lib.bytes)} />
              </div>
              {data.formats.length > 0 && (
                <div className="card formats">
                  <h3 className="card-title">Formats</h3>
                  <ul className="rank-list compact">
                    {data.formats.slice(0, 8).map((f) => (
                      <li key={f.label} className="rank-row static">
                        <span className="rank-name">{f.label}</span>
                        <Meter value={f.tracks} max={formatMax} />
                        <span className="rank-val">
                          <b>{plural(f.tracks, 'song')}</b>
                          <span className="faint">{lib.tracks ? `${Math.round((f.tracks / lib.tracks) * 100)}%` : ''}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
          {data.topAlbums[0] && !empty && (
            <p className="stats-foot faint">
              Most played album: <a onClick={() => navigate(albumRoute(data.topAlbums[0].id, data.topAlbums[0].hqRip))}>{data.topAlbums[0].title}</a>
            </p>
          )}
        </div>
      )}
    </div>
  )
}
