// TIDAL artist page: albums, EPs & singles and compilations, each tile with badge + download.

import { TIDAL_IPC, type TidalAlbumSummary, type TidalArtistDetail } from '@shared/ipc/tidal'
import { invoke } from '../../lib/ipc'
import { plural } from '../../lib/format'
import { Artwork, Empty, IconButton, showMenu } from '../../components/ui'
import { CenterSpin, copyLink, openLink, ErrorState, useRemote } from './source-kit'
import { AlbumGrid } from './items'
import { tidalLogin } from './tidal-state'

export function ArtistPage({ id }: { id: string }) {
  const r = useRemote(`artist:${id}`, () => invoke<TidalArtistDetail>(TIDAL_IPC.artist, id), { refetchOnLibrary: true })
  if (!r.data) {
    if (r.error) return <ErrorState source="tidal" error={r.error} onRetry={r.reload} onLogin={() => void tidalLogin()} />
    return <CenterSpin />
  }
  const { artist, albums, epsAndSingles, compilations } = r.data
  const all = [...albums, ...epsAndSingles, ...compilations]
  const inLib = all.filter((a) => a.badge.status === 'in-library').length
  const partial = all.filter((a) => a.badge.status === 'partial').length
  const info = [plural(albums.length, 'album'), epsAndSingles.length ? plural(epsAndSingles.length, 'EP or single', 'EPs & singles') : null]
  const lib = [inLib ? `${inLib} in your library` : null, partial ? `${partial} partially` : null].filter(Boolean).join(', ')
  return (
    <>
      <div className="hero src-hero">
        <Artwork url={artist.picture} className="hero-art round" title={artist.name} />
        <div className="hero-meta">
          <span className="hero-kicker">Artist · TIDAL</span>
          <h1 className="hero-title">{artist.name}</h1>
          <span className="hero-info">{info.filter(Boolean).join(' · ')}</span>
          {lib && <span className="hero-info faint">{lib}</span>}
          <div className="hero-actions">
            <IconButton icon="more" title="More" onClick={(e) => showMenu(e, [{ label: 'Open on TIDAL', icon: 'link', onClick: () => openLink(artist.url) }, { label: 'Copy TIDAL Link', icon: 'link', onClick: () => copyLink(artist.url) }])} />
          </div>
        </div>
      </div>
      {!all.length && <Empty icon="albums" title="No releases">TIDAL lists no releases for this artist in your region.</Empty>}
      <Section title="Albums" list={albums} />
      <Section title="EPs & Singles" list={epsAndSingles} />
      <Section title="Compilations" list={compilations} />
    </>
  )
}

function Section({ title, list }: { title: string; list: TidalAlbumSummary[] }) {
  if (!list.length) return null
  return (
    <section className="section">
      <h2 className="section-title">
        {title}
        <span className="faint tidal-count">{list.length}</span>
      </h2>
      <AlbumGrid albums={list} />
    </section>
  )
}
