// TIDAL JSON → renderer summaries (see @shared/ipc/tidal).

import { joinCredit } from '@shared/artist-credit'
import type {
  TidalAlbumSummary,
  TidalArtistRefSummary,
  TidalArtistSummary,
  TidalPlaylistSummary,
  TidalQueueState,
  TidalTrackSummary,
} from '@shared/ipc/tidal'
import type { InLibraryBadge } from '@shared/types'
import { imageUrl } from './config'
import { fullTitle, mainArtists } from './mapper'
import type { TidalAlbum, TidalArtist, TidalArtistRef, TidalPlaylist, TidalTrack } from './types'

const refs = (list: TidalArtistRef[] | undefined, primary?: TidalArtistRef): TidalArtistRefSummary[] =>
  (list?.length ? list : primary ? [primary] : []).map((a) => ({ id: String(a.id), name: a.name }))

export function albumSummary(a: TidalAlbum, badge: InLibraryBadge, queue?: TidalQueueState): TidalAlbumSummary {
  const year = Number((a.releaseDate ?? '').slice(0, 4))
  return {
    id: String(a.id),
    title: fullTitle(a.title, a.version),
    artist: joinCredit(mainArtists(a.artists, a.artist)),
    artists: refs(a.artists, a.artist),
    cover: imageUrl(a.cover, 640),
    releaseDate: a.releaseDate ?? null,
    year: year > 0 ? year : null,
    numberOfTracks: a.numberOfTracks ?? 0,
    numberOfVolumes: a.numberOfVolumes ?? 1,
    durationSec: a.duration ?? 0,
    type: a.type ?? 'ALBUM',
    explicit: !!a.explicit,
    quality: a.audioQuality ?? null,
    mediaTags: a.mediaMetadata?.tags ?? [],
    upc: a.upc ?? null,
    url: `https://tidal.com/browse/album/${a.id}`,
    badge,
    ...(queue ? { queue } : {}),
  }
}

export function trackSummary(t: TidalTrack, inLibrary: boolean, queue?: TidalQueueState): TidalTrackSummary {
  return {
    id: String(t.id),
    title: fullTitle(t.title, t.version),
    artist: joinCredit(mainArtists(t.artists, t.artist)),
    artists: refs(t.artists, t.artist),
    album: t.album ? { id: String(t.album.id), title: fullTitle(t.album.title, t.album.version), cover: imageUrl(t.album.cover, 320) } : null,
    trackNumber: t.trackNumber ?? 0,
    volumeNumber: t.volumeNumber ?? 1,
    durationSec: t.duration ?? 0,
    explicit: !!t.explicit,
    isrc: t.isrc ?? null,
    quality: t.audioQuality ?? null,
    streamable: t.streamReady !== false && t.allowStreaming !== false,
    url: `https://tidal.com/browse/track/${t.id}`,
    inLibrary,
    ...(queue ? { queue } : {}),
  }
}

export function artistSummary(a: TidalArtist, libraryTracks = 0): TidalArtistSummary {
  return {
    id: String(a.id),
    name: a.name,
    picture: imageUrl(a.picture, 320),
    url: `https://tidal.com/browse/artist/${a.id}`,
    inLibrary: libraryTracks > 0,
    ...(libraryTracks ? { libraryTracks } : {}),
  }
}

export function playlistSummary(p: TidalPlaylist, badge: InLibraryBadge | null = null): TidalPlaylistSummary {
  return {
    uuid: p.uuid,
    title: p.title,
    description: p.description ?? null,
    numberOfTracks: p.numberOfTracks ?? 0,
    durationSec: p.duration ?? 0,
    // Playlist `image` is 3:2 (750x500); `squareImage` is square.
    image: p.squareImage ? imageUrl(p.squareImage, 640) : p.image ? imageUrl(p.image, 640)!.replace('640x640', '750x500') : null,
    creator: p.creator?.name ?? null,
    url: `https://tidal.com/browse/playlist/${p.uuid}`,
    badge,
  }
}

export function countBadge(have: boolean[]): InLibraryBadge {
  const n = have.filter(Boolean).length
  return { status: n === 0 ? 'missing' : n === have.length ? 'in-library' : 'partial', have: n, total: have.length }
}
