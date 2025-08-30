#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const sanitize = require('sanitize-filename');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on('unhandledRejection', (e) => {
  console.error('UNHANDLED REJECTION:', e && e.stack || e);
  process.exitCode = 1;
});
process.on('uncaughtException', (e) => {
  console.error('UNCAUGHT EXCEPTION:', e && e.stack || e);
  process.exit(1);
});

function parseArgs(argv) {
  // node webtoon.js <URL> [outDir] [pdfName] [--debug] [--wait=ms]
  const rest = [];
  let debug = false;
  let wait = 0;
  for (const a of argv.slice(2)) {
    if (a === '--debug') { debug = true; continue; }
    if (a.startsWith('--wait=')) { wait = Number(a.split('=')[1] || 0); continue; }
    rest.push(a);
  }
  if (!rest.length) {
    console.log('Usage: node webtoon.js <URL> [outDir] [pdfName] [--debug] [--wait=ms]');
    process.exit(1);
  }
  const url = rest[0];
  const outDir = rest[1] && !/\.pdf$/i.test(rest[1]) ? rest[1] : 'images';
  const pdfName = rest[2] && /\.pdf$/i.test(rest[2])
    ? rest[2]
    : (rest[1] && /\.pdf$/i.test(rest[1]) ? rest[1] : 'episode.pdf');
  return { url, outDir, pdfName, debug, wait };
}

async function autoScroll(frame) {
  await frame.evaluate(async () => {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    let last = 0, stable = 0;
    for (let i = 0; i < 150; i++) {
      window.scrollBy(0, window.innerHeight);
      await delay(400);
      const h = document.scrollingElement.scrollHeight;
      if (h === last) { if (++stable >= 3) break; } else { stable = 0; last = h; }
    }
    window.scrollTo(0, 0);
  });
}

async function collectFromFrame(frame) {
  return await frame.evaluate(() => {
    const pickLargestFromSrcset = (srcset) => {
      try {
        const parts = srcset.split(',').map(s => s.trim());
        const parsed = parts.map(p => {
          const [u, sz] = p.split(/\s+/);
          const val = sz?.endsWith('w') ? parseInt(sz) :
                      sz?.endsWith('x') ? parseFloat(sz) * 1000 : 0;
          return { u, val };
        });
        parsed.sort((a,b) => b.val - a.val);
        const best = parsed[0]?.u || '';
        return best ? new URL(best, location.href).href : '';
      } catch { return ''; }
    };
    const items = [];
    const push = (src, rect) => {
      if (!src) return;
      try { src = new URL(src, location.href).href; } catch {}
      if (rect.width > 50 && rect.height > 50) {
        items.push({ src: src.split('#')[0], y: Math.round(rect.top + scrollY) });
      }
    };
    document.querySelectorAll('img').forEach(img => {
      const rect = img.getBoundingClientRect();
      let final = img.currentSrc || img.src || '';
      const srcset = img.getAttribute('srcset');
      if (srcset) final = pickLargestFromSrcset(srcset) || final;
      push(final, rect);
    });
    document.querySelectorAll('source[srcset]').forEach(s => {
      const rect = s.parentElement?.getBoundingClientRect?.() || {width:0,height:0,top:0};
      const ss = s.getAttribute('srcset');
      if (ss) push(pickLargestFromSrcset(ss), rect);
    });
    document.querySelectorAll('*').forEach(el => {
      const bg = getComputedStyle(el).backgroundImage || '';
      const m = bg.match(/url\((['"]?)(.*?)\1\)/);
      if (m && m[2]) push(m[2], el.getBoundingClientRect());
    });
    const seen = new Set(); const out = [];
    items.sort((a,b)=>a.y-b.y).forEach(it => { if (!seen.has(it.src)) { seen.add(it.src); out.push(it); }});
    return out;
  });
}

async function collectAllImages(page) {
  await autoScroll(page.mainFrame());
  let all = [];
  for (const fr of page.frames()) {
    try { all = all.concat(await collectFromFrame(fr)); } catch {}
  }
  const seen = new Set(); const out = [];
  all.sort((a,b)=>a.y-b.y).forEach(it => { if (!seen.has(it.src)) { seen.add(it.src); out.push(it); }});
  return out.map((it, i) => ({ ...it, idx: i }));
}

async function downloadViaNetwork(page, images, outDir) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const saved = [];
  const want = new Map(images.map(i => [i.src, i]));
  const pending = new Map();

  const onResp = async (response) => {
    try {
      if (response.request().resourceType() !== 'image') return;
      const url = response.url().split('#')[0];
      const meta = want.get(url); if (!meta || pending.has(url)) return;
      const p = (async () => {
        const buf = await response.buffer();
        let out = path.join(outDir, `${String(meta.idx).padStart(4,'0')}.png`);
        await sharp(buf).png().toFile(out);
        saved.push(out);
        return out;
      })();
      pending.set(url, p);
    } catch {}
  };

  page.on('response', onResp);

  // force decode
  for (const { src } of images) {
    await page.evaluate(async (s) => {
      try { const img = new Image(); img.src = s; await img.decode().catch(()=>{}); } catch {}
    }, src);
  }

  await page.waitForNetworkIdle({ idleTime: 1500, timeout: 30000 }).catch(()=>{});
  await Promise.all([...pending.values()]);
  page.off('response', onResp);

  saved.sort();
  return saved;
}

async function screenshotFallback(page, outDir) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const total = await page.evaluate(() =>
    Math.max(
      document.body.scrollHeight, document.documentElement.scrollHeight,
      document.body.offsetHeight, document.documentElement.offsetHeight,
      document.body.clientHeight, document.documentElement.clientHeight
    )
  );
  const vp = await page.viewport();
  const step = (vp && vp.height) || 800;
  let y = 0, idx = 0; const shots = [];
  while (y < total) {
    await page.evaluate((_y)=>window.scrollTo(0,_y), y);
    await sleep(300);
    const f = path.join(outDir, `shot_${String(idx).padStart(3,'0')}.png`);
    await page.screenshot({ path: f, fullPage: false });
    shots.push(f);
    y += step; idx++;
    if (idx > 500) break;
  }
  // assemble
  const metas = await Promise.all(shots.map(p => sharp(p).metadata()));
  const width = Math.max(...metas.map(m => m.width || 0));
  const height = metas.reduce((acc, m) => acc + (m.height || 0), 0);
  const composite = [];
  let offset = 0;
  for (let i = 0; i < shots.length; i++) {
    composite.push({ input: await sharp(shots[i]).toBuffer(), top: offset, left: 0 });
    offset += metas[i].height || 0;
  }
  const stitched = path.join(outDir, 'stitched.png');
  await sharp({ create: { width, height, channels: 4, background: '#ffffff' } })
    .composite(composite).png().toFile(stitched);
  return [stitched];
}

async function imagesToPdf(files, pdfPath) {
  if (!files.length) throw new Error('No images to build PDF');
  const doc = new PDFDocument({ autoFirstPage: false });
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);
    (async () => {
      for (const f of files) {
        try {
          const meta = await sharp(f).metadata();
          const w = meta.width, h = meta.height;
          if (!w || !h) throw new Error('Missing dimensions');
          doc.addPage({ size: [w, h], margins: { top:0,left:0,right:0,bottom:0 } });
          doc.image(f, 0, 0, { width: w, height: h });
        } catch (e) {
          console.log(`⚠️ Skip: ${f} - ${e.message}`);
        }
      }
      doc.end();
    })().catch(reject);
  });
}

(async function main() {
  const { url, outDir, pdfName, debug, wait } = parseArgs(process.argv);

  console.log(`🌐 ${url}`);
  const browser = await puppeteer.launch({
    headless: debug ? false : 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process'
    ],
    defaultViewport: { width: 1280, height: 1800 }
  });
  const page = await browser.newPage();
  await page.setUserAgent(UA);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 0 });
  if (wait > 0) await sleep(wait);

  const images = await collectAllImages(page);
  console.log(`📸 ${images.length} images détectées (après tri). Téléchargement…`);

  let files = await downloadViaNetwork(page, images, outDir);
  console.log(`✅ ${files.length}/${images.length} sauvegardées.`);
  if (!files.length) {
    console.log('⚠️ Aucune image récupérée — fallback screenshots…');
    files = await screenshotFallback(page, outDir);
  }

  const pdfPath = path.join(outDir, sanitize(pdfName));
  await imagesToPdf(files, pdfPath);
  console.log(`📄 PDF généré : ${pdfPath}`);

  // nettoyage des images pour ne garder que le PDF
  try {
    for (const f of files) { fs.unlinkSync(f); }
  } catch {}

  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error('FATAL:', e && e.stack || e);
  process.exit(1);
});
