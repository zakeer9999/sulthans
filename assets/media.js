/* Sulthan's — dish media resolver.
   Dish video lives in Cloudflare R2 at <mediaBase>/<dishId>/video.mp4 with a
   still at <dishId>/poster.<posterExt>. config.dishVideos lists the uploaded ids;
   everything else keeps its typographic ground, so a media outage can never
   stop someone ordering. An optional manifest.json can still override paths for
   dishes whose files do not follow the convention. */
(function () {
  const abs = (u, base) => !u ? null : /^https?:/.test(u) ? u : base ? base + '/' + u.replace(/^\//, '') : u;

  const lib = {
    name: 'media',
    async load(MEDIA, cfg) {
      const base = String((cfg && cfg.mediaBase) || '').replace(/\/+$/, '');

      // Convention first: an id in the list needs no manifest entry at all.
      // Phones export stills as .jpeg as often as .jpg, so the extension is a
      // config value rather than something to rename 47 files over.
      const ext = ((cfg && cfg.posterExt) || 'jpg').replace(/^\./, '');
      const listed = (cfg && cfg.dishVideos) || [];

      // Hero frame sequence, if it has been uploaded. Same convention: a folder
      // of stills next to the dish folders, so it needs a count and nothing else.
      /* Hero video: two renders of the same clip, dense keyframes so the scrub
         seeks cheaply on mid-range Android. `heroWide` picks which render every
         screen gets — set it to 0 to send the 1080 to phones too, which is worth
         testing when the 720 looks noisy rather than merely soft. */
      const hv = (cfg && cfg.heroVideo) || null;
      if (hv && hv.dir && base) {
        /* Width only. `Math.max(innerWidth, innerHeight)` counted a 932pt-tall
           phone as a tablet and sent it the 1080 — the hero is portrait and
           sticky, so the width is what the frame is actually fitted to. */
        const cut = hv.wideAt == null ? 900 : hv.wideAt;
        const wide = window.innerWidth >= cut;
        const pick = wide ? (hv.tablet || hv.phone) : (hv.phone || hv.tablet);
        if (pick) {
          MEDIA.heroVideo = base + '/' + hv.dir + '/' + pick;
          MEDIA.heroBytes = (hv.bytes && hv.bytes[pick]) || 0;
          // The render this screen did not pick, kept as a fallback: uploading a
          // new phone file and leaving the tablet one stale is easy to do, and
          // the wrong outcome is a black hero rather than a slightly wrong size.
          const other = wide ? hv.phone : hv.tablet;
          if (other && other !== pick) MEDIA.heroVideoAlt = base + '/' + hv.dir + '/' + other;
        }
        if (hv.poster) MEDIA.heroPoster = base + '/' + hv.dir + '/' + hv.poster;
      }

      /* Gate on presence, not truthiness: `count: 0` has to be able to turn a
         sequence OFF, not just fail to turn one on. Truthiness let a non-null
         default survive an explicit disable in config. */
      const hf = (cfg && cfg.heroFrames) || null;
      if (hf) {
        MEDIA.heroFrames = hf.count ? {
          dir: base ? base + '/hero-frames' : './media/hero-frames',
          count: hf.count,
          ext: (hf.ext || 'webp').replace(/^\./, ''),
        } : null;
      }

      /* Video container per dish. Video Prep uploads with the extension of the
         file you picked, so an iPhone .mov landed in the bucket as video.mov
         while this resolver still asked for video.mp4 — a 404 and a black
         player. An entry may now carry its own extension ('n-mandi-2.mov');
         bare ids fall back to cfg.videoExt, then mp4. */
      const vext = ((cfg && cfg.videoExt) || 'mp4').replace(/^\./, '');
      listed.forEach(entry => {
        if (!entry || !base) return;
        const s = String(entry);
        const dot = s.lastIndexOf('.');
        const id = dot > 0 ? s.slice(0, dot) : s;
        const v = dot > 0 ? s.slice(dot + 1) : vext;
        MEDIA.dishes[id] = { hls: base + '/' + id + '/video.' + v, poster: base + '/' + id + '/poster.' + ext };
      });

      let m = null;
      try {
        const r = await fetch((base || '.') + (base ? '/manifest.json' : '/media/manifest.json'), { cache: 'no-cache' });
        if (r.ok) m = await r.json();
      } catch (e) { /* optional file — the list above is the source of truth */ }
      if (!m) return { ok: !!listed.length, count: listed.length, via: 'config' };
      if (m.hero) {
        // Hero is byte-scrubbed, so it stays a progressive MP4 — HLS cannot seek
        // frame-accurately against a download bar.
        if (m.hero.mp4) MEDIA.heroVideo = abs(m.hero.mp4, base);
        if (m.hero.bytes) MEDIA.heroBytes = m.hero.bytes;
        if (m.hero.frames) MEDIA.heroFrames = { dir: abs(m.hero.frames.dir, base), count: m.hero.frames.count };
      }
      // config.dishVideos gates the menu; the manifest may only refine the paths
      // of ids already listed there. A stale manifest left in the bucket used to
      // be able to re-add a dish whose files were never uploaded, which mounts a
      // black player at the table — the one failure this module exists to avoid.
      Object.keys(m.dishes || {}).forEach(id => {
        const v = m.dishes[id] || {};
        if (!v.hls && !v.mp4) return;
        if (!MEDIA.dishes[id]) {
          console.warn('[media] manifest.json lists "' + id + '" but config.dishVideos does not — ignoring.');
          return;
        }
        // Poster stays on the posterExt convention: the manifest in the bucket
        // is hand-written and has guessed the wrong extension before, and a
        // wrong poster path is a broken still on a working video.
        MEDIA.dishes[id] = {
          hls: abs(v.hls || v.mp4, base) || MEDIA.dishes[id].hls,
          poster: MEDIA.dishes[id].poster,
        };
      });
      const n = Object.keys(MEDIA.dishes).length;
      return { ok: !!n, count: n, via: 'config + manifest' };
    },
    // Dish rows in Supabase can carry hls_url/poster_url; those win over the manifest.
    merge(MEDIA, fromDb) {
      Object.keys(fromDb || {}).forEach(id => { MEDIA.dishes[id] = fromDb[id]; });
    },
  };

  (window.SULTHANS_LIBS = window.SULTHANS_LIBS || {}).media = lib;
  window.dispatchEvent(new CustomEvent('sulthans:lib', { detail: 'media' }));
})();
