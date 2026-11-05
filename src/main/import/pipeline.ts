// The import pipeline: SourceRelease (files + source metadata) → identified, tagged, transcoded,
// loudness-measured files placed in the library, lossless masters + original art in the archive,
// an import report with undo information, and ledger entries for the other devices.

import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { cpus } from 'node:os'
import { extname, join } from 'node:path'
import type { AudioFormat, TrackTags } from '@shared/types'
import { encodeSourceQuality, decodeSourceQuality } from '@shared/quality'
import { RIP_GENRE } from '@shared/types'
import { cleanText, foldKey } from '@shared/sanitize'
import type { Logger, SettingsStore, ValenceEnv } from '@main/context'
import { SourceError, type SourceRelease, type Transport } from './source-types'
import { probeFile, type ProbeResult } from '@main/tags/read'
import { writeTags } from '@main/tags/write'
import { encode, planFor, toFlacMaster, type ProfileId } from '@main/media/transcode'
import { albumGain, measureLoudness, trackGain, type Loudness } from '@main/media/replaygain'
import { embeddable, extForMime, fetchImage, loadImage, pickBest, type Image } from '@main/media/artwork'
import { chooseRelPath, placeFile, toAbs } from '@main/library/organizer'
import { pool } from '@main/library/scanner'
import type { LibraryService } from '@main/library/service'
import { claimValenceId, decide, formatQuality, type DedupeDecision } from './dedupe'
import type { Archive } from './archive'
import type { ImportAction, Reports, ReportSummary } from './report'
import { inferLooseCluster, mergeTags, pickGenre, type IdentifyInput, type IdentifyResult, type MetadataService, type ReleaseCandidate } from '@main/metadata'

export type CandidateLike = ReleaseCandidate
type IdentifyInputLike = IdentifyInput
type IdentifyResultLike = IdentifyResult

export interface PipelineDeps {
  env: ValenceEnv
  settings: SettingsStore
  log: Logger
  library: LibraryService
  archive: Archive
  reports: Reports
  transport: Transport
  trash: (abs: string) => Promise<void>
  metadata: Pick<MetadataService, 'identify' | 'applyRelease' | 'lyrics'> | null
}

export interface ReviewData {
  status: 'review' | 'unmatched'
  score: number
  candidates: CandidateLike[]
  tracks: Array<{ index: number; title: string; artist: string; album: string; durationMs: number; relPath?: string }>
}

export type PipelineOutcome =
  | { status: 'done'; reportId: string; summary: ReportSummary }
  | { status: 'review'; review: ReviewData }

export interface PipelineOptions {
  jobId: string
  signal?: AbortSignal
  progress?: (fraction: number, message: string) => void
  /** Resolution chosen in the Review UI. */
  choice?: { releaseId?: string; asIs?: boolean }
  /** Loose imports: park ambiguous matches for review instead of importing as-is. */
  reviewAmbiguous?: boolean
}

interface Prepared {
  index: number
  src: string
  probe: ProbeResult
  tags: TrackTags
  decision: DedupeDecision
  loudness?: Loudness | null
}

function singleGenre(g: string | undefined): string | undefined {
  if (!g) return undefined
  const first = g.split(/\s*(?:;|\/|,|\|)\s*/)[0]
  return cleanText(first) || undefined
}

function ensureTotals(tracks: Array<{ tags: TrackTags }>): void {
  const byDisc = new Map<number, number>()
  for (const t of tracks) {
    const d = t.tags.discnumber ?? 1
    byDisc.set(d, Math.max(byDisc.get(d) ?? 0, t.tags.tracknumber ?? 0))
  }
  for (const t of tracks) {
    if (t.tags.tracknumber && !t.tags.totaltracks) t.tags.totaltracks = byDisc.get(t.tags.discnumber ?? 1) || undefined
  }
}

export async function runPipeline(release: SourceRelease, deps: PipelineDeps, opts: PipelineOptions): Promise<PipelineOutcome> {
  const { env, settings, log, library } = deps
  const signal = opts.signal
  const progress = opts.progress ?? (() => {})
  const workDir = join(env.stagingDir, `job-${opts.jobId}`, 'out')
  await mkdir(workDir, { recursive: true })
  const reportId = randomUUID()
  const actions: ImportAction[] = []
  const summary: ReportSummary = { added: 0, upgraded: 0, skipped: 0, archived: 0, errors: 0, identified: release.source === 'import' ? 'unmatched' : 'source', release: release.title }

  // 1. Probe.
  progress(0.02, 'Reading files')
  const probes: Array<ProbeResult | null> = await Promise.all(
    release.tracks.map(async (t) => {
      try {
        return await probeFile(t.file, { covers: true })
      } catch (e) {
        log.warn(`import: unreadable ${t.file}`, (e as Error).message)
        return null
      }
    }),
  )
  const live = release.tracks.map((t, i) => ({ t, i, probe: probes[i] })).filter((x) => x.probe) as Array<{ t: SourceRelease['tracks'][number]; i: number; probe: ProbeResult }>
  for (const [i, p] of probes.entries()) {
    if (!p) {
      actions.push({ kind: 'error', detail: { file: release.tracks[i].file, error: 'Unreadable audio file' } })
      summary.errors++
    }
  }
  if (!live.length) throw new Error('No readable audio files in this release')

  // 2. Layers: source (tidal/bandcamp), existing tags, filename/folder heuristics.
  const isLoose = release.source === 'import'
  const sourceLayers = live.map(({ t }) => (isLoose ? null : { ...release.albumTags, ...t.tags }))
  const existingLayers = live.map(({ t, probe }) => (isLoose ? { ...probe.tags, ...t.tags } : probe.tags))
  const relPaths = live.map(({ t }) => (t.raw as { relPath?: string } | undefined)?.relPath ?? t.file.split(/[\\/]/).slice(-2).join('/'))
  const heuristicLayers =
    isLoose
      ? inferLooseCluster(live.map(({ probe }, k) => ({ relPath: relPaths[k], tags: existingLayers[k], durationMs: probe.format.durationMs })))
      : live.map(() => null)

  // 3. Identify with MusicBrainz.
  let ident: IdentifyResultLike | null = null
  const mbEnabled = !release.skipLookups && settings.get('metadata.musicbrainz', true) && deps.metadata && !opts.choice?.asIs
  if (mbEnabled) {
    progress(0.08, 'Looking up MusicBrainz')
    const input: IdentifyInputLike = {
      source: release.source,
      albumTags: isLoose ? { ...(heuristicLayers[0] ?? {}), ...existingLayers[0], ...release.albumTags } : release.albumTags,
      tracks: live.map(({ probe }, k) => ({
        index: k,
        tags: { ...(heuristicLayers[k] ?? {}), ...(isLoose ? existingLayers[k] : sourceLayers[k]!) },
        durationMs: probe.format.durationMs,
        relPath: relPaths[k],
        file: live[k].t.file,
      })),
    }
    try {
      ident = opts.choice?.releaseId ? await deps.metadata!.applyRelease(opts.choice.releaseId, input) : await deps.metadata!.identify(input, signal)
    } catch (e) {
      if (signal?.aborted) throw e
      log.warn('import: MusicBrainz lookup failed; continuing with existing metadata', (e as Error).message)
    }
    if (ident && isLoose) summary.identified = opts.choice?.releaseId ? 'manual' : ident.status
    if (ident && isLoose && ident.status === 'review' && opts.reviewAmbiguous && !opts.choice) {
      return {
        status: 'review',
        review: {
          status: 'review',
          score: ident.score,
          candidates: ident.candidates,
          tracks: live.map(({ probe }, k) => ({
            index: k,
            title: existingLayers[k].title ?? heuristicLayers[k]?.title ?? '',
            artist: existingLayers[k].artist ?? heuristicLayers[k]?.artist ?? '',
            album: existingLayers[k].album ?? heuristicLayers[k]?.album ?? '',
            durationMs: probe.format.durationMs,
            relPath: relPaths[k],
          })),
        },
      }
    }
  }
  const mbConfident = !!ident && (ident.status === 'auto' || !!opts.choice?.releaseId)

  // 4. Merge per track.
  const prepared: Prepared[] = []
  const claimedIds = new Set<string>()
  const bandcampTags = ((release.raw as { tags?: string[] } | undefined)?.tags ?? []).map((name) => ({ name }))
  for (const [k, { t, probe }] of live.entries()) {
    const mbTags = ident && (mbConfident || !isLoose) ? { ...ident.albumTags, ...(ident.trackTags[k] ?? {}) } : ident?.trackTags[k] ? { ...ident.albumTags, ...ident.trackTags[k] } : null
    const merged = mergeTags(
      { source: sourceLayers[k], mb: mbTags, existing: existingLayers[k], heuristic: heuristicLayers[k] },
      isLoose ? 'musicbrainz-first' : 'source-first',
      mbConfident,
    ).tags
    let genre = singleGenre(merged.genre)
    if (!genre && bandcampTags.length) genre = pickGenre(bandcampTags, undefined)
    if (!genre) genre = singleGenre(probe.tags.genre)
    // Rips carry one fixed genre so players that only read standard tags can still separate them.
    if (merged.hq_rip) genre = RIP_GENRE
    const tags: TrackTags = {
      ...merged,
      genre,
      rating: probe.tags.rating ?? merged.rating,
      valence_id: probe.tags.valence_id ?? merged.valence_id ?? randomUUID(),
      valence_owner: env.deviceId,
      source: release.source,
      source_quality: (!isLoose && t.tags.source_quality) || encodeSourceQuality(formatQuality(probe.format)),
    }
    if (!tags.title) tags.title = relPaths[k].split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'Untitled'
    const quality = decodeSourceQuality(tags.source_quality) ?? formatQuality(probe.format)
    const decision = decide(library.db, tags, probe.format.durationMs, quality)
    if (decision.kind === 'upgrade') {
      // A better copy replaces the track rather than starting a new one: it keeps the track's
      // Valence ID (plays, likes and playlists follow on every device) and its rating.
      tags.valence_id = decision.existing.valence_id ?? tags.valence_id
      if (!tags.rating && decision.existing.rating) tags.rating = decision.existing.rating
    }
    if (decision.kind !== 'skip') tags.valence_id = claimValenceId(library.db, tags.valence_id, decision.kind === 'upgrade' ? decision.existing.id : null, claimedIds)
    prepared.push({ index: k, src: t.file, probe, tags, decision })
  }
  ensureTotals(prepared)

  // 5. Lyrics (only for tracks being imported).
  const todo = prepared.filter((p) => p.decision.kind !== 'skip')
  for (const p of prepared) {
    if (p.decision.kind === 'skip') {
      actions.push({ kind: 'skip', relPath: p.decision.existing.rel_path, detail: { title: p.tags.title, artist: p.tags.artist, reason: p.decision.reason } })
      summary.skipped++
    }
  }
  if (!release.skipLookups && deps.metadata && settings.get('lyrics.fetch', true)) {
    progress(0.15, 'Fetching lyrics')
    await pool(todo.filter((p) => !p.tags.lyrics), 2, async (p) => {
      try {
        const l = await deps.metadata!.lyrics({ artist: p.tags.artist ?? p.tags.albumartist ?? '', title: p.tags.title!, album: p.tags.album, durationMs: p.probe.format.durationMs })
        const text = l?.synced || l?.plain
        if (text) p.tags.lyrics = text
      } catch {
        /* lyrics are optional */
      }
    }, signal)
  }

  if (!todo.length) {
    reportAndLedger()
    return { status: 'done', reportId, summary }
  }

  // Masters have nowhere to go while the archive drive is away: wait for it before writing anything.
  const profile = settings.get<ProfileId>('transcode.profile', 'mp3-320')
  const needsMaster = (p: Prepared) => {
    const plan = planFor(p.probe.format, profile, extname(p.src).slice(1))
    return p.probe.format.lossless && (plan.kind !== 'encode' || !plan.profile.lossless)
  }
  if (!deps.archive.accepting() && todo.some(needsMaster)) throw new SourceError('Waiting for the archive drive', 'archive-offline')

  // 6. Artwork.
  progress(0.2, 'Artwork')
  const maxArt = settings.get('art.maxSize', 2000)
  const transport = deps.transport
  const sourceArt = release.artwork?.file
    ? await loadImage(release.artwork.file)
    : release.artwork?.url
      ? await fetchImage([release.artwork.url, ...(release.artwork.fallbackUrls ?? [])], transport, signal)
      : null
  const embeddedArt = pickEmbedded(prepared.map((p) => p.probe.picture))
  let original: Image | null = sourceArt
  if (!original || (isLoose && mbConfident)) {
    const caa = ident?.coverArtUrls?.length && (mbConfident || !original) ? await fetchImage(ident.coverArtUrls, transport, signal) : null
    original = await pickBest([original, caa, embeddedArt])
  }
  original ??= embeddedArt
  const embedArt = original ? await embeddable(original, maxArt).catch(() => original) : null

  // 7. Loudness (on the source; ReplayGain differences vs. the transcode are negligible).
  const concurrency = Math.max(1, Math.min(cpus().length - 2, 8))
  if (settings.get('import.replaygain', true)) {
    progress(0.25, 'Measuring loudness')
    await pool(prepared, concurrency, async (p) => {
      p.loudness = await measureLoudness(p.src, signal).catch(() => null)
    }, signal)
    const album = albumGain(prepared.map((p) => p.loudness).filter((l): l is Loudness => !!l))
    for (const p of todo) {
      if (!p.loudness) continue
      const tg = trackGain(p.loudness)
      p.tags.replaygain_track_gain = tg.gain
      p.tags.replaygain_track_peak = tg.peak
      if (album) {
        p.tags.replaygain_album_gain = album.gain
        p.tags.replaygain_album_peak = album.peak
      }
    }
  }

  // 8. Transcode/copy, tag, archive, place.
  const templateFor = (tags: TrackTags) => library.templateFor(tags)
  const taken = new Set<string>()
  const placed: string[] = []
  let done = 0
  let albumRelDir: string | null = null
  await pool(todo, concurrency, async (p) => {
    if (signal?.aborted) return
    const n = String(p.index).padStart(3, '0')
    const fmt: AudioFormat = p.probe.format
    const plan = planFor(fmt, profile, extname(p.src).slice(1))
    try {
      // Library file.
      const ext = plan.kind === 'encode' ? plan.profile.ext : plan.ext
      const out = join(workDir, `${n}.${ext}`)
      if (plan.kind === 'encode') await encode(p.src, out, plan.profile, fmt, signal)
      else await copyFile(p.src, out)
      await writeTags(out, p.tags, { artwork: embedArt })

      // Lossless master to the archive.
      let archived: { where: 'archive' | 'pending'; rel: string } | null = null
      const template = templateFor(p.tags)
      const libRel = await chooseRelPath(env.libraryRoot, p.tags, ext, {
        template,
        taken,
        // foldKey: the file being upgraded may be spelled with another case or Unicode normalization.
        isSelf: p.decision.kind === 'upgrade' ? (r) => foldKey(r) === foldKey((p.decision as { existing: { rel_path: string } }).existing.rel_path) : undefined,
      })
      taken.add(foldKey(libRel))
      if (needsMaster(p)) {
        const master = join(workDir, `${n}.master.flac`)
        if (fmt.codec === 'flac') await copyFile(p.src, master)
        else await toFlacMaster(p.src, master, signal)
        await writeTags(master, p.tags, { artwork: embedArt })
        archived = await deps.archive.put(master, libRel.replace(/\.[^.]+$/, '.flac'))
        actions.push({ kind: 'archive', relPath: archived.rel, detail: { where: archived.where, title: p.tags.title } })
        summary.archived++
      }

      // Upgrade: vault + trash the old file first so the new one can take its path.
      let restore: { vault: string; relPath: string } | undefined
      if (p.decision.kind === 'upgrade') {
        const oldAbs = toAbs(env.libraryRoot, p.decision.existing.rel_path)
        restore = { vault: await deps.reports.vault(reportId, oldAbs), relPath: p.decision.existing.rel_path }
        await deps.trash(oldAbs)
        library.indexer.removeByPath(p.decision.existing.rel_path)
      }
      let finalRel: string
      try {
        const r = await placeFile(out, env.libraryRoot, libRel, {
          move: true,
          rechoose: () => chooseRelPath(env.libraryRoot, p.tags, ext, { template, taken }),
        })
        finalRel = r.relPath
      } catch (e) {
        if (restore) await placeFile(restore.vault, env.libraryRoot, restore.relPath).catch(() => {})
        throw e
      }
      placed.push(finalRel)
      albumRelDir ??= finalRel.slice(0, finalRel.lastIndexOf('/'))
      const quality = p.tags.source_quality
      if (p.decision.kind === 'upgrade') {
        summary.upgraded++
        const old = p.decision.existing
        // Playlists point at paths, and the better copy may sit at a new one (another extension).
        if (finalRel !== old.rel_path) library.playlists.pathMoved(old.rel_path, finalRel)
        // A track without a Valence ID kept its plays and like under its path; move them to the ID.
        const rekey = !old.valence_id && p.tags.valence_id ? { from: `path:${old.rel_path}`, to: p.tags.valence_id } : undefined
        if (rekey) library.rekeyTrack(rekey.from, rekey.to)
        actions.push({
          kind: 'upgrade',
          relPath: finalRel,
          detail: { title: p.tags.title, artist: p.tags.artist, quality, replaced: old.rel_path, oldQuality: old.source_quality },
          undo: { removeLibrary: finalRel, removeArchive: archived ?? undefined, restore, rekey },
        })
      } else {
        summary.added++
        actions.push({ kind: 'add', relPath: finalRel, detail: { title: p.tags.title, artist: p.tags.artist, quality }, undo: { removeLibrary: finalRel, removeArchive: archived ?? undefined } })
      }
    } catch (e) {
      if (signal?.aborted) throw e
      summary.errors++
      actions.push({ kind: 'error', detail: { title: p.tags.title, file: p.src, error: (e as Error).message } })
      log.error(`import: failed ${p.src}`, e)
    }
    done++
    progress(0.3 + 0.65 * (done / todo.length), `Imported ${done} of ${todo.length}`)
  }, signal)
  if (signal?.aborted) throw new Error('cancelled')

  // 9. Original art + extras to the archive album folder.
  if (albumRelDir && original) {
    const resized = !embedArt || embedArt.data !== original.data
    if (resized || settings.get('art.archiveOriginals', true)) {
      const r = await deps.archive.putBuffer(original.data, `${albumRelDir}/cover-original.${extForMime(original.mime)}`, workDir).catch(() => null)
      if (r) actions.push({ kind: 'archive', relPath: r.rel, detail: { where: r.where, kind: 'cover' }, undo: { removeArchive: r } })
    }
  }
  if (albumRelDir && release.extras?.length) {
    for (const x of release.extras) {
      try {
        const tmp = join(workDir, `extra-${randomUUID().slice(0, 6)}${extname(x)}`)
        await copyFile(x, tmp)
        const r = await deps.archive.put(tmp, `${albumRelDir}/extras/${x.split(/[\\/]/).pop()}`)
        actions.push({ kind: 'archive', relPath: r.rel, detail: { where: r.where, kind: 'extra' }, undo: { removeArchive: r } })
      } catch (e) {
        log.warn('import: extra not archived', (e as Error).message)
      }
    }
  }

  // 10. Index, report, ledger.
  progress(0.97, 'Indexing')
  if (placed.length) await library.indexPaths(placed)
  reportAndLedger()
  await rm(workDir, { recursive: true, force: true }).catch(() => {})
  progress(1, 'Done')
  return { status: 'done', reportId, summary }

  function reportAndLedger(): void {
    deps.reports.save({ id: reportId, jobId: opts.jobId, title: release.title, source: release.source, summary, actions })
    for (const a of actions) {
      if (a.kind !== 'add' && a.kind !== 'upgrade') continue
      library.deviceLog.append('ledger', { op: a.kind, rel: a.relPath, keys: release.releaseKeys, report: reportId, q: a.detail?.quality })
    }
  }
}

function pickEmbedded(pics: Array<{ data: Buffer; mime: string } | null>): Image | null {
  // Most common embedded picture (by size) wins; ties go to the largest.
  const counts = new Map<number, { img: Image; n: number }>()
  for (const p of pics) {
    if (!p) continue
    const e = counts.get(p.data.length)
    if (e) e.n++
    else counts.set(p.data.length, { img: p, n: 1 })
  }
  let best: { img: Image; n: number } | null = null
  for (const e of counts.values()) if (!best || e.n > best.n || (e.n === best.n && e.img.data.length > best.img.data.length)) best = e
  return best?.img ?? null
}

