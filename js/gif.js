// Minimal animated GIF89a encoder for the GIF export (js/app-export.js).
// DOM-free: frames are RGBA byte arrays (ImageData.data), all w x h.
//
// One global 256-color palette. Diagrams are flat UI graphics, so their colors
// usually fit exactly; when they do not, pixels snap to a fixed 6x7x6 color
// cube (no dithering). ponytail: a fixed cube, not median-cut; add a real
// quantizer if gradients or photos ever end up in exports.

/* exported encodeGIF */

// Map every pixel to a palette index. Returns { palette: [0xRRGGBB], index(r,g,b) }.
function _gifPalette(frames) {
  const seen = new Map();
  outer: for (const f of frames) {
    for (let i = 0; i < f.length; i += 4) {
      const c = (f[i] << 16) | (f[i + 1] << 8) | f[i + 2];
      if (!seen.has(c)) {
        if (seen.size === 256) { seen.clear(); break outer; }
        seen.set(c, seen.size);
      }
    }
  }
  if (seen.size) return { palette: [...seen.keys()], index: (r, g, b) => seen.get((r << 16) | (g << 8) | b) };
  const palette = [];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 7; g++) for (let b = 0; b < 6; b++)
    palette.push((Math.round(r * 51) << 16) | (Math.round(g * 42.5) << 8) | Math.round(b * 51));
  return { palette, index: (r, g, b) => Math.round(r / 51) * 42 + Math.round(g / 42.5) * 6 + Math.round(b / 51) };
}

// LZW-compress palette indices into GIF image data sub-blocks.
function _gifLZW(px, out) {
  const min = 8, clear = 1 << min, eoi = clear + 1;
  let size = min + 1, next = eoi + 1, dict = new Map();
  let buf = 0, nbits = 0;
  const block = [];
  const flush = () => { out.push(block.length); for (const x of block) out.push(x); block.length = 0; };
  const emit = code => {
    buf |= code << nbits;
    nbits += size;
    while (nbits >= 8) {
      block.push(buf & 255); buf >>= 8; nbits -= 8;
      if (block.length === 255) flush();
    }
  };
  out.push(min);
  emit(clear);
  let prefix = px[0];
  for (let i = 1; i < px.length; i++) {
    const k = px[i], key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      // The decoder adds each entry one code later, so widen once the code
      // just added no longer fits.
      if (next > (1 << size) && size < 12) size++;
    } else {
      emit(clear);
      dict = new Map(); size = min + 1; next = eoi + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (nbits > 0) block.push(buf & 255);
  if (block.length) flush();
  out.push(0);
}

// frames: RGBA arrays (w*h*4); delayCs: hundredths of a second per frame.
// Returns the GIF file as a Uint8Array. Loops forever.
function encodeGIF(frames, w, h, delayCs = 20) {
  const { palette, index } = _gifPalette(frames);
  const out = [];
  const u16 = v => out.push(v & 255, (v >> 8) & 255);
  const ascii = s => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };
  ascii('GIF89a');
  u16(w); u16(h);
  out.push(0xF7, 0, 0); // global color table of 256 entries
  for (let i = 0; i < 256; i++) {
    const c = palette[i] || 0;
    out.push((c >> 16) & 255, (c >> 8) & 255, c & 255);
  }
  out.push(0x21, 0xFF, 11); ascii('NETSCAPE2.0'); out.push(3, 1, 0, 0, 0); // loop forever
  for (const f of frames) {
    out.push(0x21, 0xF9, 4, 0); u16(delayCs); out.push(0, 0);
    out.push(0x2C); u16(0); u16(0); u16(w); u16(h); out.push(0);
    const px = new Uint8Array(w * h);
    for (let i = 0; i < px.length; i++) px[i] = index(f[i * 4], f[i * 4 + 1], f[i * 4 + 2]);
    _gifLZW(px, out);
  }
  out.push(0x3B);
  return Uint8Array.from(out);
}
