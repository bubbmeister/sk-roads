// Builds approximate map geometry for each road conditions row.
//
// For every unique roadway + location in docs/sk-roads.json it:
//   1. splits the location text ("A to B") into two places,
//   2. geocodes both with OpenStreetMap Nominatim,
//   3. routes between them with the public OSRM server,
//   4. saves the encoded polyline to docs/segments.json.
// The scraper then attaches these polylines to each row.
//
// The geometry is APPROXIMATE: it is the fastest driving route between the two end
// places, not an official road centreline. Segments flagged "suspect" probably did
// not follow the named highway. Fix those by adding an encoded polyline to
// segments.manual.json, like:  { "Highway 11|Saskatoon to Prince Albert": "<polyline>" }
//
// Usage:
//   node build-segments.mjs            only builds segments that are missing or failed
//   node build-segments.mjs --refresh  rebuilds everything (manual overrides are kept)
//
// Both services are free public servers with fair-use policies, so this runs slowly
// (about one request per second), identifies itself, caches results, and stops
// immediately if either service answers 403 or 429.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const ROADS_FILE = 'docs/sk-roads.json';
const SEGMENTS_FILE = 'docs/segments.json';
const MANUAL_FILE = 'segments.manual.json';
const GEOCACHE_FILE = 'geocache.json';
const USER_AGENT =
  'GingrichDieselMap-SegmentBuilder/1.0 (personal project; occasional geometry build, 1 request/second)';
const PAUSE_MS = 1200;
const refresh = process.argv.includes('--refresh');

// Stop gracefully after this many minutes so progress is saved and committed before
// GitHub's 30-minute workflow limit. Just run the workflow again to continue.
const MAX_MINUTES = 22;
const startedAt = Date.now();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

class StopError extends Error {}

async function politeFetch(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  await sleep(PAUSE_MS);
  if (res.status === 403 || res.status === 429) {
    throw new StopError(`HTTP ${res.status} from ${new URL(url).host}. Stopping, not retrying.`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

// "Saskatoon to Prince Albert" -> ["Saskatoon", "Prince Albert"]
function parseEnds(location) {
  // Drop a label before a colon, like "Highway 11: ..." or "Ice Road: ...".
  const text = location.includes(':') ? location.slice(location.indexOf(':') + 1) : location;
  // Try with bracketed text removed first, then with the brackets just stripped.
  const candidates = [text.replace(/\([^)]*\)/g, ' '), text.replace(/[()]/g, ' ')];
  for (const raw of candidates) {
    const cleaned = raw
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(?:highway|hwy)\s*\d+[A-Za-z]?\s*[:,\-–]?\s*/i, '');
    const match =
      cleaned.match(/(?:from|between)\s+(.+?)\s+(?:to|and)\s+(.+)$/i) ??
      cleaned.match(/^(.+?)\s+(?:to|and|-|–|—)\s+(.+)$/i);
    if (match) return [match[1].trim(), match[2].trim()];
  }
  return null;
}

async function geocode(place, cache) {
  if (place in cache) return cache[place];
  const params = new URLSearchParams({
    q: `${place}, Saskatchewan, Canada`,
    format: 'jsonv2',
    limit: '1',
    countrycodes: 'ca',
  });
  const hits = await politeFetch(`https://nominatim.openstreetmap.org/search?${params}`);
  cache[place] = hits[0] ? { lat: Number(hits[0].lat), lon: Number(hits[0].lon) } : null;
  return cache[place];
}

async function route(a, b) {
  const coords = `${a.lon},${a.lat};${b.lon},${b.lat}`;
  const url =
    `https://router.project-osrm.org/route/v1/driving/${coords}` +
    '?overview=full&geometries=polyline&steps=true';
  const data = await politeFetch(url);
  const best = data.routes?.[0];
  if (!best) throw new Error('No route found');
  return best;
}

function straightLineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// Share of the route distance on road segments whose ref/name contains the highway number.
function highwayShare(osrmRoute, number) {
  if (!number) return null;
  const pattern = new RegExp(`(^|\\D)${number}(\\D|$)`);
  let total = 0;
  let onHighway = 0;
  for (const leg of osrmRoute.legs ?? []) {
    for (const step of leg.steps ?? []) {
      total += step.distance;
      if (pattern.test(`${step.ref ?? ''} ${step.name ?? ''}`)) onHighway += step.distance;
    }
  }
  return total ? onHighway / total : null;
}

const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

async function buildSegment(item, geocache) {
  if (/ice road/i.test(item.roadway) || /ice road/i.test(item.area)) {
    return {
      encodedPolyline: null,
      status: 'skipped',
      reason: 'Ice roads are not on the normal road network',
    };
  }

  const ends = parseEnds(item.location);
  if (!ends) return { encodedPolyline: null, status: 'failed', reason: 'Could not split location into two places' };

  const [fromName, toName] = ends;
  const from = await geocode(fromName, geocache);
  const to = await geocode(toName, geocache);
  if (!from || !to) {
    return {
      encodedPolyline: null,
      status: 'failed',
      reason: `Could not find ${!from ? fromName : toName} on the map`,
    };
  }

  const found = await route(from, to);
  const number = item.roadway.match(/(\d+)/)?.[1];
  const share = highwayShare(found, number);
  const distanceKm = found.distance / 1000;
  const detour = distanceKm / Math.max(straightLineKm(from, to), 1);
  const looksRight = detour <= 1.6 && (share === null || share >= 0.5);

  return {
    encodedPolyline: found.geometry,
    status: looksRight ? 'ok' : 'suspect',
    distanceKm: round(distanceKm, 1),
    highwayShare: share === null ? null : round(share, 2),
    from: fromName,
    to: toName,
  };
}

const roads = readJson(ROADS_FILE, null);
if (!roads?.items?.length) {
  console.error(`Missing or empty ${ROADS_FILE}. Run the scraper workflow first.`);
  process.exit(1);
}

const manual = readJson(MANUAL_FILE, {});
const geocache = readJson(GEOCACHE_FILE, {});
const segments = refresh ? {} : { ...(readJson(SEGMENTS_FILE, {}).segments ?? {}) };

for (const [key, polyline] of Object.entries(manual)) {
  segments[key] = { encodedPolyline: polyline, status: 'manual' };
}

const unique = new Map();
for (const item of roads.items) unique.set(`${item.roadway}|${item.location}`, item);

function save() {
  writeJson(SEGMENTS_FILE, {
    generatedAt: new Date().toISOString(),
    note: 'Approximate geometry: fastest driving route between the two end places.',
    segments,
  });
  writeJson(GEOCACHE_FILE, geocache);
}

let stopped = false;
let builtCount = 0;
for (const [key, item] of unique) {
  const have = segments[key];
  if (have && have.status !== 'failed') continue;

  if ((Date.now() - startedAt) / 60_000 > MAX_MINUTES) {
    console.log(`Time limit of ${MAX_MINUTES} minutes reached. Run the workflow again to continue.`);
    break;
  }

  try {
    segments[key] = await buildSegment(item, geocache);
    console.log(`${segments[key].status.padEnd(8)} ${key}`);
    builtCount += 1;
    if (builtCount % 20 === 0) save();
  } catch (err) {
    if (err instanceof StopError) {
      console.error(err.message);
      stopped = true;
      break;
    }
    segments[key] = { encodedPolyline: null, status: 'failed', reason: err.message };
    console.log(`failed   ${key} (${err.message})`);
  }
}

save();

const counts = {};
for (const seg of Object.values(segments)) counts[seg.status] = (counts[seg.status] ?? 0) + 1;
console.log('Summary:', counts);
if (stopped) process.exit(1);
