// What the TV shows while Valence casts to it: the album art, the song's title, artist and album,
// a play bar, and the lyrics when they're turned on. The phone runs everything; this page plays the
// one song it's given and draws it. Add ?demo=1 to the address to see it in a browser, without a TV.
'use strict';

(function () {
  const NAMESPACE = 'urn:x-cast:app.valence';
  const $ = (id) => document.getElementById(id);
  const audio = document.querySelector('audio');

  // How long the player can sit idle before the screen goes dark. Between songs it's idle briefly;
  // that shouldn't blink the screen.
  const IDLE_BLANK_MS = 4000;

  const page = {
    trackId: null,
    artUrl: null,
    lyricsOn: false,
    /** Lyrics of the song on screen: {lines:[{t,x}]} or {text}, or null if it has none. */
    lyrics: null,
    /** The lyrics of [track] still arriving, in parts. */
    incoming: null,
    /** Lyrics that came in before the song they belong to. */
    early: null,
    lineIndex: -2,
    lastFraction: 0,
  };

  // ---- Drawing -------------------------------------------------------------------------------

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function showSong(song) {
    setText($('title'), song.title || '');
    setText($('artist'), song.artist || '');
    setText($('album'), song.album || '');
    $('album').style.display = song.album ? '' : 'none';
    showArt(song.art || null);
    if (song.trackId !== page.trackId) {
      page.trackId = song.trackId;
      page.lyrics = null;
      page.incoming = null;
      if (page.early && page.early.track === song.trackId) {
        page.lyrics = page.early.lyrics;
      }
      page.early = null;
      drawLyrics();
    }
    document.body.classList.remove('idle');
  }

  function showArt(url) {
    if (url === page.artUrl) return;
    page.artUrl = url;
    if (!url) {
      $('art').removeAttribute('src');
      clearBackdrop();
      return;
    }
    // The old cover stays up until the new one has arrived, so the screen never flashes empty.
    const next = new Image();
    next.onload = () => {
      if (page.artUrl !== url) return;
      $('art').src = url;
      drawBackdrop(next);
    };
    next.onerror = () => {
      if (page.artUrl !== url) return;
      $('art').removeAttribute('src');
      clearBackdrop();
    };
    next.src = url;
  }

  function drawBackdrop(image) {
    const canvas = $('backdrop');
    const ctx = canvas.getContext('2d');
    // Cover the canvas, keeping the picture's shape.
    const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const w = image.naturalWidth * scale;
    const h = image.naturalHeight * scale;
    ctx.imageSmoothingQuality = 'high';
    if ('filter' in ctx) ctx.filter = 'blur(1.2px)';
    ctx.drawImage(image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }

  function clearBackdrop() {
    const canvas = $('backdrop');
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss;
  }

  function showProgress(posSec, durSec) {
    const fraction = durSec > 0 ? Math.min(1, Math.max(0, posSec / durSec)) : 0;
    if (fraction !== page.lastFraction) {
      $('fill').style.transform = 'scaleX(' + fraction.toFixed(5) + ')';
      page.lastFraction = fraction;
    }
    setText($('pos'), formatTime(posSec));
    setText($('dur'), formatTime(durSec));
    followLyrics(posSec, fraction);
  }

  function showPaused(paused) {
    document.body.classList.toggle('paused', paused);
  }

  function showIdle() {
    document.body.classList.add('idle');
    page.trackId = null;
    page.artUrl = null;
    page.lyrics = null;
    page.incoming = null;
    $('art').removeAttribute('src');
    clearBackdrop();
    drawLyrics();
    showProgress(0, 0);
  }

  // ---- Lyrics --------------------------------------------------------------------------------

  /** Lays out the lyrics of the song on screen, or the plain layout if it has none. */
  function drawLyrics() {
    const lines = $('lines');
    lines.textContent = '';
    lines.classList.remove('plain');
    lines.style.transform = '';
    page.lineIndex = -2;
    const lyrics = page.lyrics;
    const has = !!lyrics && (lyrics.text || (lyrics.lines && lyrics.lines.length > 0));
    document.body.classList.toggle('lyrics', page.lyricsOn && !!has);
    if (!has) return;
    if (lyrics.lines) {
      for (const line of lyrics.lines) {
        const p = document.createElement('p');
        p.textContent = line.x || '♪';
        lines.appendChild(p);
      }
    } else {
      lines.classList.add('plain');
      const p = document.createElement('p');
      p.textContent = lyrics.text;
      lines.appendChild(p);
    }
  }

  function followLyrics(posSec, fraction) {
    if (!page.lyricsOn || !page.lyrics) return;
    const lines = $('lines');
    const box = $('lyrics');
    if (page.lyrics.lines) {
      // A hair early, as on the phone: the eye gets there before the ear.
      const ms = posSec * 1000 + 150;
      const all = page.lyrics.lines;
      let i = -1;
      while (i + 1 < all.length && all[i + 1].t <= ms) i++;
      if (i === page.lineIndex) return;
      page.lineIndex = i;
      const nodes = lines.children;
      for (let n = 0; n < nodes.length; n++) {
        nodes[n].className = n === i ? 'on' : Math.abs(n - i) <= 3 ? 'near' : '';
      }
      const focus = nodes[Math.max(i, 0)];
      if (!focus) return;
      const y = box.clientHeight / 2 - focus.offsetTop - focus.offsetHeight / 2;
      lines.style.transform = 'translateY(' + Math.round(y) + 'px)';
    } else {
      // Plain words have no times: they scroll along with the song.
      const room = lines.scrollHeight - box.clientHeight;
      const y = room > 0 ? -room * fraction : (box.clientHeight - lines.scrollHeight) / 2;
      lines.style.transform = 'translateY(' + Math.round(y) + 'px)';
    }
  }

  function setLyricsOn(on) {
    if (on === page.lyricsOn) return;
    page.lyricsOn = on;
    drawLyrics();
  }

  function onLyricsPart(message) {
    const track = message.track;
    let incoming = page.incoming;
    if (!incoming || incoming.track !== track || message.part === 0) {
      incoming = page.incoming = { track: track, parts: new Array(message.parts), left: message.parts };
    }
    if (incoming.parts[message.part] === undefined) {
      incoming.parts[message.part] = message.data;
      incoming.left--;
    }
    if (incoming.left > 0) return;
    page.incoming = null;
    let lyrics = null;
    try {
      lyrics = JSON.parse(incoming.parts.join(''));
    } catch (e) {
      console.warn('Bad lyrics message', e);
    }
    if (track === page.trackId) {
      page.lyrics = lyrics;
      drawLyrics();
    } else {
      // The phone can get these here before the song has started to load.
      page.early = { track: track, lyrics: lyrics };
    }
  }

  function onMessage(message) {
    if (!message) return;
    if (message.t === 'settings') setLyricsOn(!!message.lyrics);
    else if (message.t === 'lyrics') onLyricsPart(message);
  }

  // ---- On a TV -------------------------------------------------------------------------------

  function songFrom(media) {
    const meta = (media && media.metadata) || {};
    const custom = (media && media.customData) || {};
    const images = meta.images || [];
    return {
      trackId: custom.trackId !== undefined ? custom.trackId : media && (media.contentUrl || media.contentId),
      title: meta.title,
      artist: meta.artist,
      album: meta.albumName,
      art: images.length ? images[0].url : null,
    };
  }

  function applyGain(media) {
    const gain = media && media.customData && media.customData.gain;
    if (typeof gain === 'number' && gain >= 0 && gain <= 1) audio.volume = gain;
  }

  function startOnTv() {
    const context = cast.framework.CastReceiverContext.getInstance();
    const player = context.getPlayerManager();
    const Events = cast.framework.events.EventType;
    const Messages = cast.framework.messages;

    const hello = () => {
      try {
        context.sendCustomMessage(NAMESPACE, undefined, { t: 'hello' });
      } catch (e) {
        console.warn('No one to say hello to yet', e);
      }
    };

    // The song being loaded: until the player has it, it still reports the song before.
    let loading = null;
    let idleSince = 0;

    player.setMessageInterceptor(Messages.MessageType.LOAD, (request) => {
      if (request && request.media) {
        // Before the song starts, so it never opens at the last song's volume.
        applyGain(request.media);
        const song = songFrom(request.media);
        loading = song.trackId;
        showSong(song);
        showPaused(false);
        showProgress(request.currentTime || 0, request.media.duration || 0);
        idleSince = 0;
      }
      return request;
    });

    const commands = Messages.Command.ALL_BASIC_MEDIA | (Messages.Command.PLAYBACK_RATE || 0);
    player.setSupportedMediaCommands(commands, false);

    context.addCustomMessageListener(NAMESPACE, (event) => onMessage(event.data));
    context.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, hello);
    context.addEventListener(cast.framework.system.EventType.READY, hello);

    // A slow, steady look at the player is simpler than tracking its many events, and light enough.
    setInterval(() => {
      const state = player.getPlayerState();
      if (state === Messages.PlayerState.IDLE) {
        if (!idleSince) idleSince = Date.now();
        if (Date.now() - idleSince >= IDLE_BLANK_MS && !document.body.classList.contains('idle')) {
          loading = null;
          showIdle();
        }
        return;
      }
      idleSince = 0;
      const media = player.getMediaInformation();
      const song = media ? songFrom(media) : null;
      if (loading !== null) {
        if (!song || song.trackId !== loading) return;
        loading = null;
      }
      if (song) showSong(song);
      showPaused(state === Messages.PlayerState.PAUSED);
      showProgress(player.getCurrentTimeSec() || 0, player.getDurationSec() || (media && media.duration) || 0);
    }, 250);

    const options = new cast.framework.CastReceiverOptions();
    options.skipPlayersLoad = true; // plain audio files need none of the video streaming players
    options.statusText = 'Valence';
    options.customNamespaces = { [NAMESPACE]: cast.framework.system.MessageType.JSON };
    context.start(options);
  }

  // ---- In a browser, to see how it looks: index.html?demo=1 ------------------------------------
  // Options: lyrics=synced|plain|off (default synced), paused=1, idle=1, noart=1, long=1

  function demoArt() {
    const c = document.createElement('canvas');
    c.width = c.height = 800;
    const g = c.getContext('2d');
    const fill = g.createLinearGradient(0, 0, 800, 800);
    fill.addColorStop(0, '#2b6c8f');
    fill.addColorStop(0.55, '#7b3f8c');
    fill.addColorStop(1, '#d9764a');
    g.fillStyle = fill;
    g.fillRect(0, 0, 800, 800);
    g.fillStyle = 'rgba(255,255,255,0.14)';
    g.beginPath();
    g.arc(520, 300, 240, 0, Math.PI * 2);
    g.fill();
    return c.toDataURL('image/jpeg', 0.9);
  }

  function startDemo(query) {
    window.valenceDemo = { onMessage: onMessage, showSong: showSong };
    const long = query.get('long') === '1';
    const words = ['Morning comes in slow', 'The kettle starts to sing', 'Nothing here to hurry for', 'A window full of spring',
      'Coffee on the counter', 'Sunlight on the floor', 'Radio is humming low', 'Someone at the door',
      'We could stay a while', 'We could stay all day', 'Let the hours wander off', 'Let them drift away'];
    const durSec = 215;
    showSong({
      trackId: 1,
      title: long ? 'A Very Long Song Title That Runs On And On Past The End Of One Line - Remastered Beyond All Recognition (Extended Version)' : 'Slow Morning',
      artist: long ? 'An Artist With A Name So Long It Cannot Possibly Fit On One Line Of The Television Screen At All' : 'The Sample Band',
      album: 'Invented For This Preview',
      art: query.get('noart') === '1' ? null : demoArt(),
    });
    const kind = query.get('lyrics') || 'synced';
    if (kind !== 'off') {
      page.lyricsOn = true;
      if (kind === 'plain') page.lyrics = { text: words.concat(words, words, words).join('\n') };
      else page.lyrics = { lines: words.concat(words).map((x, i) => ({ t: i * 6000 + 2000, x: i % 6 === 5 ? '' : x })) };
      drawLyrics();
    }
    if (query.get('idle') === '1') return showIdle();
    const paused = query.get('paused') === '1';
    showPaused(paused);
    let pos = Number(query.get('pos') || 37);
    showProgress(pos, durSec);
    if (!paused) {
      setInterval(() => {
        pos = (pos + 0.25) % durSec;
        showProgress(pos, durSec);
      }, 250);
    }
  }

  const query = new URLSearchParams(location.search);
  if (query.get('demo')) startDemo(query);
  else startOnTv();
})();
