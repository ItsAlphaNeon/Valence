# Valence TV screen

The page a TV or Chromecast shows while the Valence Android app casts to it: album art, lyrics if
they're turned on, the song's details, and a play bar. The phone runs everything and this page draws it.

It's a Google Cast custom receiver, served from GitHub Pages because Cast needs an https address.

To see it in a browser, without a TV, add `?demo=1` to the address. The other options are
`lyrics=synced|plain|off`, `paused=1`, `idle=1`, `noart=1` and `long=1`.
