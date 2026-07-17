import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

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

  return { items, nextOffset: offset + (json.data?.length || 0) };
}

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) {
    return res.status(400).json({ error: 'Missing q parameter' });
  }

  const offset = decodeCursor(req.query.cursor);
  const { items, nextOffset } = await searchGiphy(q, offset);
  const nextCursor = items.length > 0 ? String(nextOffset) : null;

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

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Storyboard search proxy running on port ${PORT}`);
});
