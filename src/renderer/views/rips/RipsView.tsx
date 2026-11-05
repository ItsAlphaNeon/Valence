// The SiivaGunner tab, as on the phone: Seasons / Albums / Games / Songs chips over season albums
// (YouTube rips), rip albums (highquality.rip and SGFR), the games that have rips, and every rip as
// one song list. Rips never appear in the main library views.

import { useMemo, useState } from 'react'
import type { AlbumRow, RipGameRow, TrackQuery } from '@shared/types'
import { LIB } from '@shared/ipc/library'
import { HQRIP_IPC, type SeasonInfo } from '@shared/ipc/hqrip'
import { invoke } from '../../lib/ipc'
import { cx, plural } from '../../lib/format'
import { useLib, useLibData } from '../../state/library'
import { playQuery } from '../../state/player'
import { navigate, useUi, type RipTab } from '../../state/ui'
import { useViewHeader } from '../../shell/header'
import { AlbumGrid } from '../../components/AlbumGrid'
import { TrackTable } from '../../components/TrackTable'
import { Artwork, Button, Empty, Segmented, Spinner } from '../../components/ui'
import { Icon } from '../../components/Icon'

const ALBUM_KINDS = ['SiIvaGunner', 'SGFR']
const SEASON_KINDS = ['YouTube']

const TABS: Array<{ value: RipTab; label: string }> = [
  { value: 'seasons', label: 'Seasons' },
  { value: 'albums', label: 'Albums' },
  { value: 'games', label: 'Games' },
  { value: 'songs', label: 'Songs' },
]

export function RipsView({ tab = 'seasons' }: { tab?: RipTab }) {
  const stats = useLib((s) => s.stats)
  useViewHeader({ color: null, title: 'SiivaGunner' })
  if (stats && stats.ripTracks === 0) return <RipsEmpty />
  if (tab === 'songs') return <RipSongs />
  if (tab === 'games') return <RipGames />
  return <RipAlbums seasons={tab === 'seasons'} />
}

/** The page title, its count line, actions, and the phone's chips. */
function RipsHead({ tab, sub, actions }: { tab: RipTab; sub: string; actions?: React.ReactNode }) {
  return (
    <>
      <div className="view-head">
        <div>
          <h1 className="view-title">SiivaGunner</h1>
          <div className="view-sub">{sub}</div>
        </div>
        {actions && <div className="view-actions">{actions}</div>}
      </div>
      <div className="pill-row">
        {TABS.map((t) => (
          <button key={t.value} className={cx('pill', tab === t.value && 'on')} onClick={() => useUi.getState().navigate({ view: 'rips', tab: t.value }, { replace: true })}>
            {t.label}
          </button>
        ))}
      </div>
    </>
  )
}

function RipsEmpty() {
  return (
    <div className="view">
      <Empty icon="disc" title="No High Quality Rips yet">
        <span>
          Download rip albums and SGFR releases from Get Rips, or set your SiIvaGunner playlist in Settings to fill the season albums. Songs you
          already have can be moved here from Get Info → High Quality Rip.
        </span>
        <span className="row">
          <Button kind="primary" icon="download" onClick={() => navigate({ view: 'hqrip' })}>
            Get Rips
          </Button>
          <Button icon="settings" onClick={() => navigate({ view: 'settings', section: 'siivagunner' })}>
            SiIvaGunner Settings
          </Button>
        </span>
      </Empty>
    </div>
  )
}

type AlbumSort = 'title' | 'year' | 'added'
const SORT_KEY = 'valence.rips.albums.sort'

/** "Season 4 Episode 2" → 4.5, "Season X" → 10; other titles sort after. */
export function seasonOrder(title: string): number {
  const m = /season\s+(x|\d+)(\s+episode\s+(\d+))?/i.exec(title)
  if (!m) return 1000
  const n = m[1].toLowerCase() === 'x' ? 10 : Number(m[1])
  return n + (m[3] ? Number(m[3]) / 10 : 0)
}

function RipAlbums({ seasons }: { seasons: boolean }) {
  const [sort, setSortState] = useState<AlbumSort>(() => (localStorage.getItem(SORT_KEY) as AlbumSort) || 'title')
  const setSort = (s: AlbumSort) => {
    setSortState(s)
    localStorage.setItem(SORT_KEY, s)
  }
  const kinds = seasons ? SEASON_KINDS : ALBUM_KINDS
  const { data } = useLibData(() => invoke<AlbumRow[]>(LIB.albums, { collection: 'rips', ripKinds: kinds, sort: seasons ? 'title' : sort }), [seasons, sort])
  const table = useLibData(() => (seasons ? invoke<SeasonInfo[]>(HQRIP_IPC.seasons) : Promise.resolve([])), [seasons]).data
  // Seasons read in channel order (the season table, else Season 1 … Season X), not alphabetically.
  const albums = useMemo(() => {
    if (!seasons || !data) return data
    const order = new Map((table ?? []).map((s, i) => [s.album, i]))
    const rank = (a: AlbumRow) => order.get(a.title) ?? 100 + seasonOrder(a.title)
    return [...data].sort((a, b) => rank(a) - rank(b))
  }, [data, seasons, table])
  const src = { kind: 'library' as const, title: seasons ? 'Seasons' : 'Rip Albums' }
  const query: TrackQuery = { collection: 'rips', ripKinds: kinds }
  return (
    <div className="view">
      <AlbumGrid
        albums={albums ?? []}
        subtitle={(a) => (seasons ? plural(a.trackCount, 'rip') : [a.albumArtist, a.year].filter(Boolean).join(' · '))}
        header={
          <RipsHead
            tab={seasons ? 'seasons' : 'albums'}
            sub={albums ? (seasons ? `${plural(albums.length, 'season')} from your YouTube playlist` : `${plural(albums.length, 'album')} from highquality.rip and SGFR`) : ' '}
            actions={
              <>
                {!seasons && (
                  <Segmented
                    value={sort}
                    onChange={setSort}
                    options={[
                      { value: 'title', label: 'Title' },
                      { value: 'year', label: 'Year' },
                      { value: 'added', label: 'Recent' },
                    ]}
                  />
                )}
                <Button icon="shuffle" onClick={() => void playQuery(query, undefined, src, true)}>
                  Shuffle all
                </Button>
              </>
            }
          />
        }
      />
      {!albums && (
        <div className="center-spin">
          <Spinner />
        </div>
      )}
      {albums && !albums.length && (
        <div className="empty">
          {seasons ? 'No season rips yet: set your SiIvaGunner playlist in Settings → SiIvaGunner.' : 'No rip albums yet: download some from Get Rips.'}
        </div>
      )}
    </div>
  )
}

const SONG_SORT_KEY = 'valence.rips.songs.sort'

function loadSort(): TrackQuery['sort'] {
  try {
    return JSON.parse(localStorage.getItem(SONG_SORT_KEY) ?? 'null') ?? undefined
  } catch {
    return undefined
  }
}

function RipSongs() {
  const stats = useLib((s) => s.stats)
  const [sort, setSort] = useState<TrackQuery['sort']>(loadSort)
  const query: TrackQuery = { collection: 'rips', sort }
  const src = { kind: 'library' as const, title: 'Rip Songs' }
  return (
    <div className="view">
      <RipsHead
        tab="songs"
        sub={stats ? plural(stats.ripTracks, 'rip') : ' '}
        actions={
          <>
            <Button kind="primary" icon="play" onClick={() => void playQuery(query, undefined, src)}>
              Play
            </Button>
            <Button icon="shuffle" onClick={() => void playQuery(query, undefined, src, true)}>
              Shuffle
            </Button>
          </>
        }
      />
      <TrackTable
        query={query}
        source={src}
        sort={sort}
        onSort={(s) => {
          setSort(s)
          localStorage.setItem(SONG_SORT_KEY, JSON.stringify(s ?? null))
        }}
        showArt
        columns={['title', 'game', 'album', 'composer', 'heart', 'time', 'plays', 'added']}
      />
    </div>
  )
}

/** Games that have rips, with how many (the phone's Games chip). */
function RipGames() {
  const games = useLibData(() => invoke<RipGameRow[]>(LIB.ripGames), []).data
  return (
    <div className="view">
      <RipsHead tab="games" sub={games ? plural(games.length, 'game') : ' '} />
      {!games ? (
        <div className="center-spin">
          <Spinner />
        </div>
      ) : !games.length ? (
        <div className="empty">Rips with a game in their tags are grouped here.</div>
      ) : (
        <div className="pl-list">
          {games.map((g) => (
            <button key={g.name} className="pl-row art" onClick={() => navigate({ view: 'game', game: g.name })}>
              <Artwork hash={g.artHash} px={96} title={g.name} />
              <span className="grow ellipsis">{g.name}</span>
              <span className="faint tnum">{plural(g.trackCount, 'rip')}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The queue source for a game's rips (GameView, search). */
export const gameSource = (game: string) => ({ kind: 'other' as const, id: `game:${game}`, title: game })

/** A game as a cover tile (search results): opens the game, the play button plays its rips. */
export function GameTile({ g }: { g: RipGameRow }) {
  return (
    <div className="tile" onClick={() => navigate({ view: 'game', game: g.name })}>
      <div className="tile-art">
        <Artwork hash={g.artHash} px={300} title={g.name} />
        <button
          className="tile-play"
          title={`Play ${g.name}`}
          onClick={(e) => {
            e.stopPropagation()
            void playQuery({ ripGame: g.name }, undefined, gameSource(g.name))
          }}
        >
          <Icon name="play" size={20} />
        </button>
      </div>
      <div className="tile-title ellipsis" title={g.name}>
        {g.name}
      </div>
      <div className="tile-sub">{plural(g.trackCount, 'rip')}</div>
    </div>
  )
}

/** A game's rips, oldest upload first. */
export function GameView({ game }: { game: string }) {
  const query: TrackQuery = { ripGame: game }
  const src = gameSource(game)
  const count = useLibData(() => invoke<{ total: number }>(LIB.tracks, { ...query, limit: 0 }), [game]).data
  useViewHeader({ color: null, title: game })
  return (
    <div className="view">
      <div className="view-head">
        <div>
          <div className="hero-kicker">Game</div>
          <h1 className="view-title">{game}</h1>
          {count && <div className="view-sub">{plural(count.total, 'rip')}</div>}
        </div>
        <div className="view-actions">
          <Button kind="primary" icon="play" onClick={() => void playQuery(query, undefined, src)}>
            Play
          </Button>
          <Button icon="shuffle" onClick={() => void playQuery(query, undefined, src, true)}>
            Shuffle
          </Button>
        </div>
      </div>
      <TrackTable query={query} source={src} showArt columns={['index', 'title', 'album', 'composer', 'heart', 'time', 'plays']} />
    </div>
  )
}
