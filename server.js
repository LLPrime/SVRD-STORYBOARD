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
app.use(express.json({ limit: '100kb' }));

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
// /api/render — turns a storyboard into an actual MP4.
//
// v1 scope, deliberately: download each panel's GIF, loop/trim it to that
// panel's exact duration, pad it onto the target canvas (square or vertical),
// then concatenate every panel in order. That's it for now.
//
// NOT in this version yet, on purpose — both are the very next additions,
// not forgotten:
//   - Caption burn-in (needs the caption fonts pulled down onto the server
//     first — drawtext needs a local font file, not a web font link)
//   - Voice/audio track overlay
// A panel with gifUrl: null renders as a plain black card for its duration
// until captions land, so the timing/pacing is still accurate to preview.
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

  if (panel.gifUrl && /^https?:\/\//.test(panel.gifUrl)) {
    const srcPath = path.join(dir, `src_${index}.gif`);
    await downloadToFile(panel.gifUrl, srcPath);
    await runFfmpeg([
      '-stream_loop', '-1', '-i', srcPath,
      '-t', String(seconds),
      '-vf', scalePad,
      '-r', String(FPS),
      '-an', '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
      outPath,
    ]);
  } else {
    // No GIF for this panel (pure caption card, or a placeholder:// URL the
    // server can't fetch) — solid black for now so timing stays accurate.
    await runFfmpeg([
      '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:d=${seconds}:r=${FPS}`,
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
      outPath,
    ]);
  }
  return outPath;
}

app.post('/api/render', async (req, res) => {
  const storyboard = req.body?.storyboard;
  const panels = Array.isArray(storyboard?.panels) ? storyboard.panels : [];
  const aspect = CANVAS[storyboard?.aspectRatio] ? storyboard.aspectRatio : 'square';
  const { w, h } = CANVAS[aspect];

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

    const outPath = path.join(dir, `out_${crypto.randomUUID()}.mp4`);
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);

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
