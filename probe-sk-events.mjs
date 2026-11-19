// One-time probe of the Highway Hotline "Traffic Events" text report.
//
// Loads the page once, with an honest user agent, and saves every event row plus everything
// found in the Map column (links, data attributes, raw HTML), so we can see whether the Map
// link carries coordinates or an event ID. Writes docs/sk-events-raw.json and prints a short
// summary to the log.
//
// Like the road conditions scraper: no retries, no evasion. If the site returns an error or a
// bot challenge, it stops and writes nothing.

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PAGE_URL = 'https://hotline.gov.sk.ca/list/events/traffic';
const OUT_FILE = 'docs/sk-events-raw.json';
const USER_AGENT =
  'GingrichDieselMap-EventsProbe/1.0 (personal project; single manual page load)';

// ---- helpers start (pure functions, tested offline) ----
// The page puts each column's name at the start of every cell, so those labels are stripped.
const LABELS = [
  'Type',
  'Roadway',
  'Description',
  'Start Time',
  'Anticipated End Time',
  'Last Updated',
  'Map',
];
const FIELDS = [
  'type',
  'roadway',
  'description',
  'startTime',
  'anticipatedEndTime',
  'lastUpdated',
  'mapText',
];

// Anything that looks like a latitude/longitude pair or a coordinate query parameter.
const COORD = /-?\d{1,3}\.\d{3,}\s*[,;&/ ]\s*-?\d{1,3}\.\d{3,}|\b(lat|lng|lon|latitude|longitude)=/i;

// Turns the raw rows read from the page into clean records.
function shapeRows(rawRows) {
  const out = [];
  const seen = new Set();
  for (const raw of rawRows) {
    // Rows start with an empty helper cell, so keep only the last 7 cells.
    if (raw.cells.length < FIELDS.length) continue;
    const cells = raw.cells.slice(-FIELDS.length);
    const rec = {};
    FIELDS.forEach((field, i) => {
      const text = cells[i].text;
      rec[field] = text.startsWith(LABELS[i]) ? text.slice(LABELS[i].length).trim() : text;
    });
    if (FIELDS.slice(0, 6).every((field) => rec[field] === '')) continue;

    const mapCell = cells[FIELDS.length - 1];
    rec.mapLinks = mapCell.links;
    rec.mapDataAttrs = mapCell.dataAttrs;
    rec.mapHtml = mapCell.html;
    rec.rowAttrs = raw.attrs;

    const key = JSON.stringify([rec.type, rec.roadway, rec.description, rec.startTime, rec.lastUpdated]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out;
}

function summarize(rows) {
  const types = {};
  let withLink = 0;
  let withCoords = 0;
  for (const row of rows) {
    types[row.type || '(blank)'] = (types[row.type || '(blank)'] ?? 0) + 1;
    if (row.mapLinks.length) withLink++;
    if (COORD.test(JSON.stringify([row.mapLinks, row.mapDataAttrs, row.rowAttrs, row.mapHtml]))) {
      withCoords++;
    }
  }
  return { total: rows.length, types, withLink, withCoords };
}
// ---- helpers end ----

async function readRows(page) {
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

  const rawRows = [];
  let lastFingerprint = '';
  for (let i = 0; i < 200; i++) {
    const pageRows = await page.$$eval('table tbody tr', (trs) =>
      trs.map((tr) => ({
        attrs: Object.fromEntries([...tr.attributes].map((a) => [a.name, a.value])),
        cells: [...tr.querySelectorAll('td')].map((td) => ({
          text: td.textContent.trim().replace(/\s+/g, ' '),
          links: [...td.querySelectorAll('a')].map((a) => ({
            href: a.href,
            rawHref: a.getAttribute('href'),
            text: a.textContent.trim().replace(/\s+/g, ' '),
            title: a.getAttribute('title'),
            ariaLabel: a.getAttribute('aria-label'),
            onclick: a.getAttribute('onclick'),
          })),
          dataAttrs: [td, ...td.querySelectorAll('*')]
            .map((el) =>
              Object.fromEntries(
                [...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => [a.name, a.value])
              )
            )
            .filter((o) => Object.keys(o).length > 0),
          html: td.innerHTML.slice(0, 600),
        })),
      }))
    );

    const fingerprint = JSON.stringify(pageRows[0] ?? []);
    if (fingerprint === lastFingerprint) break;
    lastFingerprint = fingerprint;
    rawRows.push(...pageRows);

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
  return rawRows;
}

async function probe() {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();

    const response = await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (!response || response.status() >= 400) {
      throw new Error(
        `Site responded with HTTP ${response ? response.status() : 'no response'}. Stopping.`
      );
    }
    const title = (await page.title()).toLowerCase();
    if (/just a moment|captcha|access denied|attention required|blocked/.test(title)) {
      throw new Error(`Bot challenge or block page detected ("${title}"). Stopping.`);
    }

    await page.waitForSelector('table tbody tr td', { state: 'attached', timeout: 30_000 });
    const rawRows = await readRows(page);
    const tableInfo = await page
      .$eval('.dataTables_info, .dt-info', (el) => el.textContent.trim())
      .catch(() => 'not found');
    return { rawRows, tableInfo };
  } finally {
    await browser.close();
  }
}

try {
  const { rawRows, tableInfo } = await probe();
  const rows = shapeRows(rawRows);
  const summary = summarize(rows);

  console.log(`Events page: ${tableInfo}`);
  console.log(`Event rows read: ${summary.total}`);
  console.log(`By type: ${JSON.stringify(summary.types)}`);
  console.log(`Rows with a link in the Map column: ${summary.withLink}`);
  console.log(`Rows where the Map cell, link or row looks like it holds coordinates: ${summary.withCoords}`);

  if (rows.length === 0) {
    console.log('No events are listed right now, so there is nothing to inspect.');
    console.log('Run this again when the Hotline shows an accident or closure.');
  } else {
    console.log('First rows (trimmed):');
    for (const row of rows.slice(0, 3)) console.log(JSON.stringify(row));
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(
    OUT_FILE,
    JSON.stringify(
      { source: PAGE_URL, fetchedAt: new Date().toISOString(), tableInfo, summary, rows },
      null,
      2
    ) + '\n'
  );
  console.log(`Saved ${rows.length} rows to ${OUT_FILE}.`);
} catch (err) {
  console.error(`Probe failed: ${err.message}`);
  process.exit(1);
}
