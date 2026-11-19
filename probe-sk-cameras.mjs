// One-time probe of the Highway Hotline camera list.
//
// Loads the camera list page once (and, only if that page does not exist, the home page once,
// to find where the cameras are linked). Saves what is there: table rows, links, image URLs
// and data attributes, so we can see how each camera is identified. Writes
// docs/sk-cameras-raw.json and prints a short summary.
//
// Same rules as the other scripts: honest user agent, no retries, no evasion. On an error or
// a bot challenge it stops and writes nothing. It does not download any camera images.

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PAGE_URL = process.env.PROBE_URL || 'https://hotline.gov.sk.ca/list/cameras';
const HOME_URL = process.env.PROBE_HOME_URL || 'https://hotline.gov.sk.ca/';
const OUT_FILE = process.env.PROBE_OUT || 'docs/sk-cameras-raw.json';
const USER_AGENT = 'GingrichDieselMap-CameraProbe/1.0 (personal project; single manual page load)';

// ---- helpers start (pure, tested offline) ----
const CAM = /cam/i;
const COORD = /-?\d{1,3}\.\d{3,}\s*[,;&/ ]\s*-?\d{1,3}\.\d{3,}|\b(lat|lng|lon|latitude|longitude)=/i;

function summarize(rows, cameraLinks, images) {
  const withLink = rows.filter((r) => r.links.length).length;
  const withImage = rows.filter((r) => r.images.length).length;
  const withCoords = rows.filter((r) => COORD.test(JSON.stringify(r))).length;
  return { rows: rows.length, withLink, withImage, withCoords, cameraLinks: cameraLinks.length, images: images.length };
}
function cameraRelated(items) {
  return items.filter((i) => CAM.test(i.href || i.src || '') || CAM.test(i.text || i.alt || ''));
}
// ---- helpers end ----

async function inspect(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const data = (el) =>
      [el, ...el.querySelectorAll('*')]
        .map((e) => Object.fromEntries([...e.attributes].filter((a) => a.name.startsWith('data-')).map((a) => [a.name, a.value])))
        .filter((o) => Object.keys(o).length);
    const rows = [...document.querySelectorAll('table tbody tr')].map((tr) => ({
      attrs: Object.fromEntries([...tr.attributes].map((a) => [a.name, a.value])),
      cells: [...tr.querySelectorAll('td')].map((td) => clean(td.textContent)),
      links: [...tr.querySelectorAll('a')].map((a) => ({ href: a.href, text: clean(a.textContent), onclick: a.getAttribute('onclick') })),
      images: [...tr.querySelectorAll('img')].map((i) => ({ src: i.src, alt: i.alt })),
      dataAttrs: data(tr),
    }));
    const links = [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: clean(a.textContent) }));
    const images = [...document.querySelectorAll('img')].map((i) => ({ src: i.src, alt: i.alt }));
    return {
      title: document.title,
      info: clean(document.querySelector('.dataTables_info, .dt-info')?.textContent),
      rows, links, images,
      bodyText: clean(document.body.innerText).slice(0, 1500),
    };
  });
}

async function load(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  const status = response ? response.status() : 0;
  const title = (await page.title()).toLowerCase();
  if (/just a moment|captcha|access denied|attention required|blocked/.test(title)) {
    throw new Error(`Bot challenge or block page detected ("${title}"). Stopping.`);
  }
  if (status >= 400) return { status, found: null };
  await page.waitForTimeout(4000); // let the page's scripts draw
  return { status, found: await inspect(page) };
}

async function probe() {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    const result = { source: PAGE_URL, fetchedAt: new Date().toISOString() };
    const first = await load(page, PAGE_URL);
    result.status = first.status;
    if (first.found) {
      result.page = first.found;
    } else {
      console.log(`${PAGE_URL} returned HTTP ${first.status}. Looking for camera links on the home page instead (one load).`);
      const home = await load(page, HOME_URL);
      result.homeStatus = home.status;
      result.page = home.found;
      result.fellBackToHome = true;
    }
    return result;
  } finally {
    await browser.close();
  }
}

try {
  const result = await probe();
  const p = result.page;
  if (!p) throw new Error('Neither the camera page nor the home page could be read. Stopping.');
  const cameraLinks = cameraRelated(p.links);
  const cameraImages = cameraRelated(p.images);
  result.summary = summarize(p.rows, cameraLinks, cameraImages);
  result.cameraLinks = cameraLinks;
  result.cameraImages = cameraImages;

  console.log(`Page title: ${p.title}`);
  console.log(`Table info: ${p.info || 'none'}`);
  console.log(`Summary: ${JSON.stringify(result.summary)}`);
  console.log('First rows (trimmed):');
  for (const row of p.rows.slice(0, 3)) console.log(JSON.stringify(row).slice(0, 500));
  console.log('Camera-related links (first 5):');
  for (const l of cameraLinks.slice(0, 5)) console.log(JSON.stringify(l));

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(result, null, 2) + '\n');
  console.log(`Saved to ${OUT_FILE}.`);
} catch (err) {
  console.error(`Probe failed: ${err.message}`);
  process.exit(1);
}
