import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const app = express();
const PORT = process.env.PORT || 3000;
const GIPHY_KEY = process.env.GIPHY_KEY;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';

if (!GIPHY_KEY) {
  console.error('Missing GIPHY_KEY. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: '20mb' }));

// Basic abuse protection on the search endpoint. Keys live only on the server,
// but nothing stops someone from hammering the endpoint if the URL leaks.
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many search requests, slow down.' },
});
app.use('/api/search', searchLimiter);

const expandLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many story-expand requests, slow down.' },
});
app.use('/api/expand', expandLimiter);

const PER_SOURCE_LIMIT = 20;

function decodeCursor(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function searchGiphy(q, offset) {
  const url = new URL('https://api.giphy.com/v1/gifs/search');
  url.searchParams.set('api_key', GIPHY_KEY);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', PER_SOURCE_LIMIT);
  url.searchParams.set('offset', offset);
  url.searchParams.set('rating', 'pg-13');

  const res = await fetch(url);
  if (!res.ok) {
    console.error('GIPHY error', res.status, await res.text().catch(() => ''));
    return { items: [], nextOffset: offset };
  }
  const json = await res.json();
  const items = (json.data || [])
    .map((item) => ({
      id: `giphy-${item.id}`,
      previewUrl:
        item.images?.fixed_width?.url ||
        item.images?.preview_gif?.url ||
        item.images?.original?.url,
      fullUrl: item.images?.original?.url,
      source: 'giphy',
    }))
    .filter((item) => item.fullUrl);

  const totalCount = json.pagination?.total_count ?? 0;
  const newOffset = offset + (json.data?.length || 0);
  const hasMore = newOffset < totalCount;

  return { items, nextOffset: newOffset, hasMore };
}

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) {
    return res.status(400).json({ error: 'Missing q parameter' });
  }

  const offset = decodeCursor(req.query.cursor);
  const { items, nextOffset, hasMore } = await searchGiphy(q, offset);
  const nextCursor = hasMore ? String(nextOffset) : null;

  res.json({ results: items, nextCursor });
});

// Small stoplist of pure grammatical glue words — deliberately keeps pronouns
// (I, me, you, we...) since those are exactly the self/other-reference anchors
// this feature is built to catch.
const STOPWORDS = new Set([
  'the','a','an','is','was','were','be','been','being','to','of','and','but',
  'so','it',"it's",'its','that','this','these','those','in','on','at','for',
  'with','as','by','or','if','then','than','too','also','just','really',
  'get','got','into','from','about','do','did','does','not'
]);

function splitBeats(text){
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 12); // cap beats per request
}

function extractAnchorWords(sentence, cap){
  const words = sentence.toLowerCase().replace(/[^a-z0-9'\s]/g, '').split(/\s+/).filter(Boolean);
  const anchors = [];
  for (const w of words) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    if (!anchors.includes(w)) anchors.push(w);
  }
  if (!anchors.length && words.length) anchors.push(words[0]); // fallback: first word of a short/all-stopword beat
  return anchors.slice(0, cap);
}

// GIPHY: related tags, mined from real tag/search co-occurrence — not AI.
async function relatedTermsGiphy(term){
  try{
    const url = new URL(`https://api.giphy.com/v1/tags/related/${encodeURIComponent(term)}`);
    url.searchParams.set('api_key', GIPHY_KEY);
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data || []).map(t => t.tag || t.name || t.term).filter(Boolean);
  }catch{ return []; }
}

app.post('/api/expand', async (req, res) => {
  const text = (req.body?.text || '').toString().trim();
  if (!text) {
    return res.status(400).json({ error: 'Missing text' });
  }

  const beats = splitBeats(text);
  const result = [];

  for (const beatText of beats) {
    const anchors = extractAnchorWords(beatText, 2); // cap anchor words per beat to bound API calls
    const seen = new Set();
    const phrases = [];

    for (const word of anchors) {
      const giphyTerms = await relatedTermsGiphy(word);
      // the anchor word itself is a guaranteed, always-relevant fallback
      if (!seen.has(word)) { seen.add(word); phrases.push(word); }
      for (const term of giphyTerms) {
        const norm = term.toLowerCase();
        if (seen.has(norm) || phrases.length >= 6) continue;
        seen.add(norm);
        phrases.push(term);
      }
    }

    result.push({ text: beatText, phrases: phrases.slice(0, 6) });
  }

  res.json({ beats: result });
});

// ---------------------------------------------------------------------------
// /api/resolve — turn a link from basically anywhere into a usable media URL.
//
// Two paths:
//  1. The pasted link is already a direct file (ends in .gif/.mp4/.webm/...)
//     — hand it straight back, no fetch needed.
//  2. It's a normal page URL (a Reddit post, a Tenor view page, a Tumblr
//     post, etc.) — fetch that page's HTML and read its Open Graph tags
//     (og:video, og:image). This is the same mechanism Discord/Slack/Twitter
//     use to unfurl link previews, so it's not one-integration-per-site —
//     it's one mechanism that works generically almost everywhere, and
//     doesn't quietly break if some site's API changes or shuts down
//     (which is exactly what happened to Tenor's actual API).
//
// Not omniscient: sites with heavy bot-blocking or that render media purely
// via JavaScript (no static meta tags) may not resolve. Errors say so plainly
// rather than pretending success.
// ---------------------------------------------------------------------------

const resolveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many link lookups, slow down.' },
});
app.use('/api/resolve', resolveLimiter);

const DIRECT_MEDIA_RE = /\.(gif|mp4|webm|mov|png|jpe?g)(\?.*)?$/i;

function isSafeExternalUrl(u) {
  let parsed;
  try { parsed = new URL(u); } catch { return false; }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  if (/^(10\.|127\.|169\.254\.|192\.168\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

function extractOgMedia(html) {
  const grab = (prop) => {
    const re = new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i');
    const m = html.match(re) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i'));
    return m ? m[1] : null;
  };
  return grab('og:video:secure_url') || grab('og:video') || grab('og:image') || grab('twitter:image');
}

app.get('/api/resolve', async (req, res) => {
  const raw = (req.query.url || '').toString().trim();
  if (!raw || !isSafeExternalUrl(raw)) {
    return res.status(400).json({ error: 'Missing or invalid url' });
  }

  if (DIRECT_MEDIA_RE.test(raw)) {
    return res.json({ mediaUrl: raw, resolvedFrom: 'direct' });
  }

  try {
    const pageRes = await fetch(raw, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
      redirect: 'follow',
    });
    if (!pageRes.ok) {
      return res.status(502).json({ error: `That page returned ${pageRes.status}` });
    }
    const html = await pageRes.text();
    const mediaUrl = extractOgMedia(html);
    if (!mediaUrl) {
      return res.status(422).json({ error: "Couldn't find a media link on that page — it may need JavaScript to load, or block this kind of request." });
    }
    res.json({ mediaUrl, resolvedFrom: new URL(raw).hostname });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach that link', detail: String(err.message || err) });
  }
});


//
// Downloads each panel's GIF, loops/trims it to that panel's exact duration,
// pads it onto the target canvas (square or vertical), burns in the caption
// (matching one of the 4 client presets as closely as ffmpeg allows), then
// concatenates every panel in order. If a voice/audio track is provided,
// it's muxed over the final video, video length staying authoritative.
//
// Honest caveats, not hidden:
//   - classic-meme (Anton) and comic-bold (Bangers) use real static font
//     files, exact match to the client's fonts.
//   - clean-sans (Inter) and handwritten (Caveat) only ship as *variable*
//     fonts now — ffmpeg's drawtext can't select a named weight instance
//     out of one (tested: asking for Thin vs Black renders byte-identical).
//     clean-sans compensates with a faux-bold outline to approximate the
//     bold weight. Caveat just renders at its default weight — still
//     unmistakably a handwritten script either way.
//   - comic-bold's slight rotation (from the CSS) isn't replicated here;
//     drawtext has no rotate option. Everything else about that preset matches.
// ---------------------------------------------------------------------------

const renderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many render requests, slow down.' },
});
app.use('/api/render', renderLimiter);

const CANVAS = {
  square: { w: 1080, h: 1080 },
  vertical: { w: 1080, h: 1920 },
};
const FPS = 24;
const MAX_PANELS = 40;
const MAX_TOTAL_MS = 3 * 60 * 1000; // 3 minutes, generous personal-project ceiling
const FONT_DIR = path.join(process.cwd(), 'fonts');
const CARD_BG = '#12141c'; // matches the client's dark card surface

const CAPTION_STYLES = {
  'classic-meme': {
    fontfile: path.join(FONT_DIR, 'Anton-Regular.ttf'),
    fontcolor: 'white', borderw: 3, bordercolor: 'black',
    uppercase: true, fontsizeRatio: 0.052,
  },
  'clean-sans': {
    fontfile: path.join(FONT_DIR, 'Inter-Variable.ttf'),
    fontcolor: 'white', borderw: 1.3, bordercolor: 'white', // faux-bold, see header note
    box: true, boxcolor: 'black@0.55', boxborderw: 14,
    fontsizeRatio: 0.042,
  },
  'comic-bold': {
    fontfile: path.join(FONT_DIR, 'Bangers-Regular.ttf'),
    fontcolor: '#ffcf3e', borderw: 2.2, bordercolor: '#1a1a1a',
    fontsizeRatio: 0.05,
  },
  'handwritten': {
    fontfile: path.join(FONT_DIR, 'Caveat-Variable.ttf'),
    fontcolor: 'white', shadow: true,
    fontsizeRatio: 0.058,
  },
};

// ffmpeg drawtext has no auto-wrap — approximate it by breaking on whitespace
// at a character-count budget scaled to the canvas width and font size.
function wrapCaption(text, canvasW, fontsize) {
  const avgCharPx = fontsize * 0.56;
  const maxChars = Math.max(8, Math.floor((canvasW * 0.86) / avgCharPx));
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

async function writeCaptionTextfile(rawText, style, canvasW, fontsize, dir, tag) {
  const text = style.uppercase ? rawText.toUpperCase() : rawText;
  const wrapped = wrapCaption(text, canvasW, fontsize);
  const filePath = path.join(dir, `caption_${tag}.txt`);
  await writeFile(filePath, wrapped, 'utf8');
  return filePath;
}

// Builds one or more drawtext filter stages for a caption. Text comes from a
// file (textfile=), not inline text=, specifically so arbitrary user caption
// content (colons, quotes, newlines, anything) never has to be escaped into
// a filter-graph string — a whole class of bugs and injection risk skipped.
function buildCaptionFilters(style, textfilePath, canvasW, canvasH, fontsize, mode) {
  const escPath = textfilePath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const y = mode === 'card' ? '(h-text_h)/2' : `h-text_h-${Math.round(canvasH * 0.07)}`;
  const common = `textfile='${escPath}':fontfile='${style.fontfile.replace(/\\/g, '/').replace(/:/g, '\\:')}':fontsize=${fontsize}:fontcolor=${style.fontcolor}:x=(w-text_w)/2:y=${y}:line_spacing=6`;

  const stages = [];
  if (style.shadow) {
    // soft drop-shadow: same text drawn once in black, offset, underneath
    stages.push(`drawtext=${common.replace(`x=(w-text_w)/2`, `x=(w-text_w)/2+2`).replace(`y=${y}`, `y=${y}+3`)}:fontcolor=black@0.55`);
  }
  let main = common;
  if (style.borderw) main += `:borderw=${style.borderw}:bordercolor=${style.bordercolor}`;
  if (style.box) main += `:box=1:boxcolor=${style.boxcolor}:boxborderw=${style.boxborderw}`;
  stages.push(`drawtext=${main}`);
  return stages;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
}

async function buildSegment(panel, index, dir, w, h) {
  const seconds = Math.max(0.2, (panel.durationMs || 2000) / 1000);
  const outPath = path.join(dir, `seg_${String(index).padStart(3, '0')}.mp4`);
  const scalePad = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;

  const hasGif = panel.gifUrl && /^https?:\/\//.test(panel.gifUrl);
  const isCard = panel.captionMode === 'card' || !hasGif;
  const caption = (panel.caption || '').toString().trim();
  const style = CAPTION_STYLES[panel.captionStyle] || CAPTION_STYLES['classic-meme'];

  let captionFilters = [];
  if (caption) {
    const fontsize = Math.round(h * style.fontsizeRatio);
    const textfilePath = await writeCaptionTextfile(caption, style, w, fontsize, dir, index);
    captionFilters = buildCaptionFilters(style, textfilePath, w, h, fontsize, isCard ? 'card' : 'overlay');
  }

  if (hasGif) {
    const srcPath = path.join(dir, `src_${index}.gif`);
    await downloadToFile(panel.gifUrl, srcPath);
    const vf = [scalePad, ...captionFilters].join(',');
    await runFfmpeg([
      '-stream_loop', '-1', '-i', srcPath,
      '-t', String(seconds),
      '-vf', vf,
      '-r', String(FPS),
      '-an', '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
      outPath,
    ]);
  } else {
    // No GIF for this panel — a caption card on a solid background instead
    // of a bare-black filler, with the caption (if any) centered on it.
    const vf = captionFilters.length ? captionFilters.join(',') : null;
    const args = [
      '-f', 'lavfi', '-i', `color=c=${CARD_BG}:s=${w}x${h}:d=${seconds}:r=${FPS}`,
    ];
    if (vf) args.push('-vf', vf);
    args.push('-pix_fmt', 'yuv420p', '-c:v', 'libx264', outPath);
    await runFfmpeg(args);
  }
  return outPath;
}

app.post('/api/render', async (req, res) => {
  const storyboard = req.body?.storyboard;
  const panels = Array.isArray(storyboard?.panels) ? storyboard.panels : [];
  const aspect = CANVAS[storyboard?.aspectRatio] ? storyboard.aspectRatio : 'square';
  const { w, h } = CANVAS[aspect];
  const audioBase64 = req.body?.audioBase64;

  if (!panels.length) {
    return res.status(400).json({ error: 'Storyboard has no panels' });
  }
  if (panels.length > MAX_PANELS) {
    return res.status(400).json({ error: `Too many panels (max ${MAX_PANELS})` });
  }
  const totalMs = panels.reduce((sum, p) => sum + (p.durationMs || 2000), 0);
  if (totalMs > MAX_TOTAL_MS) {
    return res.status(400).json({ error: 'Storyboard is too long (max 3 minutes total)' });
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'storyboard-render-'));
  try {
    const segmentPaths = [];
    for (let i = 0; i < panels.length; i++) {
      segmentPaths.push(await buildSegment(panels[i], i, dir, w, h));
    }

    const listPath = path.join(dir, 'list.txt');
    const listContent = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    await writeFile(listPath, listContent);

    const concatPath = path.join(dir, `concat_${crypto.randomUUID()}.mp4`);
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', concatPath]);

    let outPath = concatPath;
    if (audioBase64) {
      const audioPath = path.join(dir, 'voice_track');
      await writeFile(audioPath, Buffer.from(audioBase64, 'base64'));
      const videoDuration = totalMs / 1000;
      const muxedPath = path.join(dir, `out_${crypto.randomUUID()}.mp4`);
      // Video duration stays authoritative: -t caps output to the video's
      // own length, so a longer voice track gets cut off, and a shorter one
      // just leaves silence for the remainder — the storyboard's timing
      // never gets stretched or shortened by whatever audio was handed in.
      await runFfmpeg([
        '-i', concatPath, '-i', audioPath,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-t', String(videoDuration),
        muxedPath,
      ]);
      outPath = muxedPath;
    }

    const { size } = await stat(outPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', size);
    res.setHeader('Content-Disposition', `attachment; filename="${(storyboard.title || 'storyboard').replace(/[^a-z0-9_-]/gi, '_')}.mp4"`);

    const { createReadStream } = await import('node:fs');
    createReadStream(outPath).pipe(res).on('close', () => {
      rm(dir, { recursive: true, force: true }).catch(() => {});
    });
  } catch (err) {
    console.error('Render error', err);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    res.status(500).json({ error: 'Render failed', detail: String(err.message || err) });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Storyboard search proxy running on port ${PORT}`);
});
