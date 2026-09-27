// Product demo videos, found by filename in public/videos/:
//   <slug>.mp4       full demo, shown in the product-page gallery
//   <slug>-loop.mp4  5–9 s silent loop for card hovers + the homepage reel
//   <slug>.webp      poster frame
// Adding a product video = dropping those three files in (encode with
// ffmpeg: H.264, no audio, 30fps, +faststart). Scanned once at startup.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'public', 'videos');

function scan() {
  let files = [];
  try { files = fs.readdirSync(DIR); } catch (e) { return {}; }
  const has = f => files.includes(f);
  const map = {};
  for (const f of files) {
    const m = /^(.+)\.mp4$/.exec(f);
    if (!m || m[1].endsWith('-loop')) continue;
    const slug = m[1];
    map[slug] = {
      src: `/videos/${slug}.mp4`,
      loop: has(`${slug}-loop.mp4`) ? `/videos/${slug}-loop.mp4` : `/videos/${slug}.mp4`,
      poster: has(`${slug}.webp`) ? `/videos/${slug}.webp` : null,
    };
  }
  return map;
}

module.exports = { productVideos: scan() };
