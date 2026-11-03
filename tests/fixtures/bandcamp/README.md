# Bandcamp fixtures — SYNTHETIC

Every file in this folder is **SYNTHETIC**. None of it was captured from a real Bandcamp account,
and no live Bandcamp traffic was made to produce it. The ids, names, signatures and URLs are made up.

The shapes copy what Bandcamp serves today, as used by open-source tools that read these pages:

- `github.com/meeb/bandcampsync`: the homepage `#HomepageApp` `data-blob` (`pageContext.identity.fanId`), the
  collection API (`items`, `redownload_urls` keyed `${sale_item_type}${sale_item_id}`, `tracklists`,
  `last_token`, `more_available`), the download page `#pagedata` → `digital_items[].downloads.<enc>.url`,
  and the `email-reauth-error` block.
- `github.com/hyphmongo/batchcamp`: the `/statdownload/` JSONP (`Downloads.statResult({...})`), `.rand`/`.vrs`
  query parameters, and the `Range: bytes=0-0` probe that answers 503 while a format is still being encoded.

| File | What it stands for |
| --- | --- |
| `homepage.html` | Logged-in `https://bandcamp.com/` with the `#HomepageApp` blob |
| `homepage-pagedata.html` | Homepage variant where only `#pagedata` `identities.fan` carries the fan id |
| `homepage-logged-out.html` | Homepage with `identity: null` |
| `fan-page.html` | Fan page (`bandcamp.com/<username>`) with `fan_data.fan_id` |
| `collection-1.json`, `collection-2.json` | Two pages of `/api/fancollection/1/collection_items` (a redownload URL for a page-1 item appears on page 2) |
| `hidden-1.json` | One page of `/api/fancollection/1/hidden_items` |
| `download-page.html` | Redownload page with two digital items (the second is the purchase) and a hidden reauth block |
| `download-page-package.html` | Redownload page for a vinyl package that includes the album download |
| `download-reauth.html` | Redownload page asking the fan to re-confirm their email (no downloads) |
| `download-no-flac.html` | Redownload page that offers MP3 only |
| `album-page.html` | Label-owned album page: `data-tralbum`, `data-embed`, `data-band`, ld+json (keywords, publisher) |
| `track-page.html` | Artist-owned standalone track page (keywords as a comma string) |

Regenerate with the script used to write them (kept outside the repo); the end-to-end test builds its own
pages at runtime with `helpers.ts` because their URLs point at a local `127.0.0.1` server.
