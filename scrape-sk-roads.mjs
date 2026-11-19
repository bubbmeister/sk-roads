// Fetches Saskatchewan road conditions from the public Highway Hotline text report
// and writes docs/sk-roads.json in the format the Diesel Map app loads for Saskatchewan
// (a "conditions" list, each with its road lines). Designed to run from GitHub Actions
// every ~30 min.
//
// Behaviour notes:
// - One page load per run, with an honest user agent. No retries, no evasion.
// - If the site returns an error or a bot challenge, the script stops and exits
//   non-zero. The last good JSON file is left untouched.
// - The file is only rewritten when the data actually changed.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const PAGE_URL = 'https://hotline.gov.sk.ca/roadconditions';
const OUT_FILE = 'docs/sk-roads.json';
const SEGMENTS_FILE = 'docs/segments.json'; // road geometry
const USER_AGENT =
  'GingrichDieselMap-RoadConditions/1.0 (personal project; one fetch every 30 minutes)';

// The page puts each column's name at the start of every cell (it is hidden on screen),
// so those labels are stripped from the values. Same order as FIELDS below.
const LABELS = [
  'Area',
  'Roadway',
  'Location',
  'Primary Condition',
  'Secondary Conditions',
  'Visibility',
  'Last Updated',
];

const FIELDS = [
  'area',
  'roadway',
  'location',
  'primaryCondition',
  'secondaryConditions',
  'visibility',
  'lastUpdated',
];

async function scrape() {
  const browser = await chromium.launch();
  try {
    // A wide viewport stops the table from collapsing columns into expandable child rows.
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();

    const response = await page.goto(PAGE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    if (!response || response.status() >= 400) {
      throw new Error(
        `Site responded with HTTP ${response ? response.status() : 'no response'}. Stopping.`
      );
    }

    const title = (await page.title()).toLowerCase();
    if (/just a moment|captcha|access denied|attention required|blocked/.test(title)) {
      throw new Error(`Bot challenge or block page detected ("${title}"). Stopping.`);
    }

    // The table body is filled in by JavaScript after load.
    // "attached" rather than "visible": the first cell in each row is an empty helper
    // column that is never visible, which made the default wait time out.
    await page.waitForSelector('table tbody tr td', { state: 'attached', timeout: 30_000 });

    // If the table is a paginated DataTable, show as many rows per page as possible.
    const lengthSelect = await page.$(
      'select[name$="_length"], .dt-length select, .dataTables_length select'
    );
    if (lengthSelect) {
      const values = await lengthSelect.$$eval('option', (opts) => opts.map((o) => o.value));
      const best = values.includes('-1')
        ? '-1'
        : [...values].sort((a, b) => Number(b) - Number(a))[0];
      await lengthSelect
        .selectOption(best, { timeout: 5_000 })
        .catch(() => console.log('Page-length control found but not usable. Skipping it.'));
      await page.waitForTimeout(500);
    }

    // Collect rows, following "next" buttons if the table is still paginated.
    const rawRows = [];
    let lastFingerprint = '';
    for (let i = 0; i < 200; i++) {
      const pageRows = await page.$$eval('table tbody tr', (trs) =>
        trs.map((tr) =>
          [...tr.querySelectorAll('td')].map((td) => td.textContent.trim().replace(/\s+/g, ' '))
        )
      );
      // Stop if clicking "next" showed the same page again.
      const fingerprint = JSON.stringify(pageRows[0] ?? []);
      if (fingerprint === lastFingerprint) break;
      lastFingerprint = fingerprint;
      rawRows.push(...pageRows);

      // Only consider a visible, enabled "next" button. Hidden copies are ignored.
      const next = page
        .locator(
          [
            '.paginate_button.next:not(.disabled):visible',
            'button.dt-paging-button.next:not(.disabled):not([disabled]):visible',
            'li.next:not(.disabled) > a:visible',
            '[aria-label="Next"]:not(.disabled):not([disabled]):visible',
            '[aria-label="Next page"]:not(.disabled):not([disabled]):visible',
          ].join(', ')
        )
        .first();
      if ((await next.count()) === 0) break;
      try {
        await next.click({ timeout: 5_000 });
      } catch {
        break;
      }
      await page.waitForTimeout(300);
    }

    const tableInfo = await page
      .$eval('.dataTables_info, .dt-info', (el) => el.textContent.trim())
      .catch(() => 'not found');
    console.log(`Table info: ${tableInfo}`);
    console.log(`Collected ${rawRows.length} raw table rows.`);

    const seen = new Set();
    const items = [];
    for (const allCells of rawRows) {
      if (allCells.length < FIELDS.length) continue;
      // Rows start with an empty helper cell, so keep only the last 7 cells.
      const cells = allCells
        .slice(-FIELDS.length)
        .map((text, idx) =>
          text.startsWith(LABELS[idx]) ? text.slice(LABELS[idx].length).trim() : text
        );
      if (cells.every((text) => text === '')) continue; // header or blank rows
      const key = cells.join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(Object.fromEntries(FIELDS.map((f, idx) => [f, cells[idx]])));
    }

    if (items.length === 0) {
      throw new Error('Parsed zero rows. Page layout may have changed. Keeping previous file.');
    }
    return items;
  } finally {
    await browser.close();
  }
}

// Adds encodedPolyline and polylineStatus to each row from docs/segments.json, if it exists.
// polylineStatus is one of: ok, suspect, manual, failed, skipped, missing.
function attachPolylines(items) {
  let segments = {};
  try {
    segments = JSON.parse(readFileSync(SEGMENTS_FILE, 'utf8')).segments ?? {};
  } catch {
    // No segments file yet: rows get null polylines.
  }
  return items.map((item) => {
    const seg = segments[`${item.roadway}|${item.location}`];
    return {
      ...item,
      encodedPolyline: seg?.encodedPolyline ?? null,
      polylineStatus: seg?.status ?? 'missing',
      // Only present when a row has separate pieces of road that don't join up.
      ...(seg?.extraPolylines ? { extraPolylines: seg.extraPolylines } : {}),
      ...(seg?.wtaId ? { wtaId: seg.wtaId } : {}),
    };
  });
}

function readPreviousPayload() {
  if (!existsSync(OUT_FILE)) return null;
  try {
    return JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// The same data in the format the Diesel Map app loads for Saskatchewan (see rdFetchOne in the
// app): a "conditions" list with an array of encoded polylines per row. Rows without a road
// line are left out, because the app can only draw rows that have one.
function buildAppPayload(items, generated) {
  const conditions = [];
  for (const item of items) {
    if (!item.encodedPolyline) continue;
    const entry = {
      source: 'sk',
      id: String(item.wtaId ?? ''),
      roadway: item.roadway,
      location: item.location,
      condition: item.primaryCondition,
      polyline: [item.encodedPolyline, ...(item.extraPolylines ?? [])],
    };
    if (item.secondaryConditions) entry.secondary = item.secondaryConditions;
    if (item.visibility) entry.visibility = item.visibility;
    if (item.lastUpdated) entry.updatedText = item.lastUpdated;
    conditions.push(entry);
  }
  return {
    ok: true,
    source: 'sk',
    credit: 'Saskatchewan Highway Hotline',
    sourceUrl: PAGE_URL,
    generated,
    counts: { conditions: conditions.length, events: 0, amber: 0, red: 0 },
    conditions,
    events: [],
  };
}

try {
  const items = attachPolylines(await scrape());
  const payload = buildAppPayload(items, '');
  const previous = readPreviousPayload();

  if (previous && JSON.stringify(previous.conditions) === JSON.stringify(payload.conditions)) {
    console.log(`No change (${payload.conditions.length} map rows). ${OUT_FILE} left as is.`);
  } else {
    // "generated" is when the road conditions last CHANGED. The app shows it as
    // "Saskatchewan updated". Runs with no change leave the file alone, so nothing is committed.
    payload.generated = new Date().toISOString();
    mkdirSync(dirname(OUT_FILE), { recursive: true });
    writeFileSync(OUT_FILE, JSON.stringify(payload));
    console.log(`Wrote ${payload.conditions.length} map rows to ${OUT_FILE}.`);
    const undrawn = items.length - payload.conditions.length;
    if (undrawn > 0) console.log(`Note: ${undrawn} rows have no road line and are not drawn.`);
  }
} catch (err) {
  console.error(`Scrape failed: ${err.message}`);
  process.exit(1);
}
