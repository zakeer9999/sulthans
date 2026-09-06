/* Sulthan's — QR encoder. Self-contained, no network, no library, no service.
   A UPI QR is not a payment gateway: it is the same upi:// string the Pay button
   uses, drawn as squares. Encoding it in the page is what lets the code carry
   the bill total, so the guest confirms an amount instead of typing one.

   Byte mode, error correction level M, versions 1-10 — comfortably more than a
   UPI string needs (~120 characters at most). Registers itself as a global and
   never asks anything of the network, so it keeps working after launch with
   nobody minding it.

   Reference: ISO/IEC 18004. The tables below are that spec's, for level M only. */
(function () {
  'use strict';

  /* ---- GF(256), the field Reed-Solomon works in ---- */
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1; if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  function genPoly(n) {
    let p = [1];
    for (let i = 0; i < n; i++) {
      const q = new Array(p.length + 1).fill(0);
      for (let j = 0; j < p.length; j++) {
        q[j] ^= mul(p[j], EXP[i]);
        q[j + 1] ^= p[j];
      }
      p = q;
    }
    return p;
  }

  function ecc(data, n) {
    // genPoly builds ascending powers; the division below wants the leading
    // coefficient first. Getting this backwards yields a perfectly well-formed
    // code that no scanner will read.
    const g = genPoly(n).reverse(), out = new Array(n).fill(0);
    for (const byte of data) {
      const f = byte ^ out[0];
      out.shift(); out.push(0);
      if (f) for (let i = 0; i < n; i++) out[i] ^= mul(g[i + 1], f);
    }
    return out;
  }

  /* ---- level-M capacity tables, versions 1-10 ---- */
  const DATA = [16, 28, 44, 64, 86, 108, 124, 154, 182, 216];
  const ECW = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  const GROUPS = [
    [[1, 16]], [[1, 28]], [[1, 44]], [[2, 32]], [[2, 43]],
    [[4, 27]], [[4, 31]], [[2, 38], [2, 39]], [[3, 36], [2, 37]], [[4, 43], [1, 44]],
  ];
  const ALIGN = [
    [], [6, 18], [6, 22], [6, 26], [6, 30],
    [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  ];

  function bch(v, g, len) {
    let d = v << len;
    const bits = n => { let b = 0; while (n) { b++; n >>>= 1; } return b; };
    while (bits(d) - 1 >= bits(g) - 1 + 0 && bits(d) > len) d ^= g << (bits(d) - bits(g));
    return d;
  }
  const formatBits = mask => {
    // level M is 00; five data bits, ten BCH bits, masked by the spec's constant
    const v = (0 << 3) | mask;
    return ((v << 10) | bch(v, 0x537, 10)) ^ 0x5412;
  };
  const versionBits = ver => (ver << 12) | bch(ver, 0x1f25, 12);

  const MASKS = [
    (i, j) => (i + j) % 2 === 0,
    (i) => i % 2 === 0,
    (i, j) => j % 3 === 0,
    (i, j) => (i + j) % 3 === 0,
    (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
    (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
    (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
  ];

  function encode(text) {
    const bytes = [];
    for (const ch of unescape(encodeURIComponent(String(text)))) bytes.push(ch.charCodeAt(0));

    let ver = 0;
    for (let v = 1; v <= 10; v++) {
      const lenBits = v < 10 ? 8 : 16;
      if (4 + lenBits + bytes.length * 8 <= DATA[v - 1] * 8) { ver = v; break; }
    }
    if (!ver) throw new Error('QR: too long');

    const size = 17 + 4 * ver, nData = DATA[ver - 1], nEc = ECW[ver - 1];
    const bits = [];
    const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    put(4, 4);
    put(bytes.length, ver < 10 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    for (let i = 0; i < 4 && bits.length < nData * 8; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);

    const words = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      words.push(b);
    }
    for (let i = 0; words.length < nData; i++) words.push(i % 2 ? 0x11 : 0xec);

    /* Blocks, then interleaved — the spec spreads a scratch across many blocks
       rather than destroying one. */
    const blocks = [], ecs = [];
    let at = 0;
    for (const [count, len] of GROUPS[ver - 1]) {
      for (let i = 0; i < count; i++) {
        const b = words.slice(at, at + len); at += len;
        blocks.push(b); ecs.push(ecc(b, nEc));
      }
    }
    const stream = [];
    const maxLen = Math.max(...blocks.map(b => b.length));
    for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.length) stream.push(b[i]);
    for (let i = 0; i < nEc; i++) for (const e of ecs) stream.push(e[i]);

    /* ---- matrix ---- */
    const m = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
    const set = (r, c, v) => { if (r >= 0 && c >= 0 && r < size && c < size) m[r][c] = v; };

    const finder = (r, c) => {
      for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
        const on = i >= 0 && i <= 6 && j >= 0 && j <= 6 &&
          (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4));
        set(r + i, c + j, on ? 1 : 0);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    for (let i = 8; i < size - 8; i++) {
      const v = i % 2 === 0 ? 1 : 0;
      m[6][i] = v; m[i][6] = v;
    }
    for (const r of ALIGN[ver - 1]) for (const c of ALIGN[ver - 1]) {
      if ((r < 8 && c < 8) || (r < 8 && c > size - 9) || (r > size - 9 && c < 8)) continue;
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
        const on = Math.max(Math.abs(i), Math.abs(j)) !== 1;
        set(r + i, c + j, on ? 1 : 0);
      }
    }
    m[size - 8][8] = 1; // the dark module, always

    // Format and version areas are reserved now and written after masking.
    /* Format info, both copies, bit 0 first. The two strips run in opposite
       directions and the spec's order is not the obvious one — laid out
       backwards the code is still perfectly formed and no scanner will touch
       it, which is exactly the failure this cost an afternoon to. */
    const fmtCells = [];
    for (let i = 0; i < 15; i++) {
      const down = i < 6 ? [i, 8] : i < 8 ? [i + 1, 8] : [size - 15 + i, 8];
      const across = i < 8 ? [8, size - 1 - i] : i === 8 ? [8, 7] : [8, 14 - i];
      fmtCells.push([down, across]);
    }
    for (const [a, b] of fmtCells) { set(a[0], a[1], 0); set(b[0], b[1], 0); }
    if (ver >= 7) {
      for (let i = 0; i < 18; i++) {
        set(Math.floor(i / 3), size - 11 + (i % 3), 0);
        set(size - 11 + (i % 3), Math.floor(i / 3), 0);
      }
    }

    const reserved = m.map(row => Array.from(row, v => v !== -1));

    let n = 0, up = true;
    for (let col = size - 1; col >= 1; col -= 2) {
      if (col === 6) col = 5; // step over the vertical timing line
      for (let k = 0; k < size; k++) {
        const r = up ? size - 1 - k : k;
        for (const cc of [col, col - 1]) {
          if (reserved[r][cc]) continue;
          const byte = stream[n >> 3];
          m[r][cc] = n < stream.length * 8 && byte !== undefined ? (byte >> (7 - (n & 7))) & 1 : 0;
          n++;
        }
      }
      up = !up;
    }

    /* Pick the mask the spec's penalty rules like best — a poorly masked code
       reads slowly or not at all on a glossy phone screen. */
    let best = null, bestScore = Infinity;
    for (let mk = 0; mk < 8; mk++) {
      const t = m.map((row, r) => Array.from(row, (v, c) => (reserved[r][c] ? v : v ^ (MASKS[mk](r, c) ? 1 : 0))));
      const f = formatBits(mk);
      for (let i = 0; i < 15; i++) {
        const bit = (f >> i) & 1, [a, b] = fmtCells[i];
        t[a[0]][a[1]] = bit; t[b[0]][b[1]] = bit;
      }
      t[size - 8][8] = 1;
      if (ver >= 7) {
        const vb = versionBits(ver);
        for (let i = 0; i < 18; i++) {
          const bit = (vb >> i) & 1;
          t[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
          t[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
        }
      }
      const s = penalty(t, size);
      if (s < bestScore) { bestScore = s; best = t; }
    }
    return { size, ver, get: (r, c) => !!best[r][c] };
  }

  function penalty(t, size) {
    let p = 0;
    const run = line => {
      let n = 1, s = 0;
      for (let i = 1; i < size; i++) {
        if (line[i] === line[i - 1]) n++;
        else { if (n >= 5) s += n - 2; n = 1; }
      }
      if (n >= 5) s += n - 2;
      return s;
    };
    for (let i = 0; i < size; i++) {
      p += run(t[i]);
      p += run(t.map(r => r[i]));
    }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
      const v = t[r][c];
      if (v === t[r][c + 1] && v === t[r + 1][c] && v === t[r + 1][c + 1]) p += 3;
    }
    const pat = [1, 0, 1, 1, 1, 0, 1];
    const hit = line => {
      let s = 0;
      for (let i = 0; i + 7 <= size; i++) {
        let ok = true;
        for (let j = 0; j < 7; j++) if (line[i + j] !== pat[j]) { ok = false; break; }
        if (!ok) continue;
        const before = line.slice(Math.max(0, i - 4), i);
        const after = line.slice(i + 7, i + 11);
        if ((before.length === 4 && before.every(x => !x)) || (after.length === 4 && after.every(x => !x))) s += 40;
      }
      return s;
    };
    for (let i = 0; i < size; i++) { p += hit(t[i]); p += hit(t.map(r => r[i])); }
    let dark = 0;
    for (const row of t) for (const v of row) dark += v;
    p += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return p;
  }

  /* Paints into a canvas the page has already sized.

     Polarity matters more than it looks. A scanner expects dark modules on a
     light field, and the sheet colours the code by screen-blending it over a
     dark ground — bright pixels become gold, dark ones stay dark. So the light
     field is what gets painted and the modules are left black: through that
     pipeline it reads as dark code on gold, the same way round as the printed
     one. Painting the modules white would produce a handsome inverted code that
     half the phones in the room would refuse. */
  function paint(canvas, text, opts) {
    const o = opts || {};
    const q = encode(text);
    const quiet = o.quiet == null ? 3 : o.quiet;
    const n = q.size + quiet * 2;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const px = Math.max(2, Math.round(((o.size || 260) * dpr) / n));
    const dim = px * n;
    canvas.width = dim; canvas.height = dim;
    const g = canvas.getContext('2d');
    g.fillStyle = o.light || '#ffffff';
    g.fillRect(0, 0, dim, dim);
    g.fillStyle = o.dark || '#000000';
    for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++) {
      if (q.get(r, c)) g.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
    }
    return q;
  }

  window.SulthansQR = { encode, paint };
  (window.SULTHANS_LIBS = window.SULTHANS_LIBS || {}).qr = true;
})();
