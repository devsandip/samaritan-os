const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('/Users/sandipdev/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const out = path.resolve(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(out, 'evidence.json'), 'utf8'));
const html = fs.readFileSync(path.join(out, 'deliberation-map.html'), 'utf8');
assert(Buffer.byteLength(html) < 1000000);
const appScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
new Function(appScript);
for (const dir of ['tmp', 'browser-profile', 'downloads']) fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
process.env.TMPDIR = path.join(__dirname, 'tmp');

async function main() {
  const errors = [];
  const context = await chromium.launchPersistentContext(path.join(__dirname, 'browser-profile'), {
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, viewport: { width: 768, height: 1100 },
    downloadsPath: path.join(__dirname, 'downloads'),
    env: { ...process.env, TMPDIR: process.env.TMPDIR },
    args: ['--disable-crash-reporter', '--no-first-run', '--disable-background-networking'],
  });
  try {
    const page = context.pages()[0];
    await page.addInitScript(() => { try { localStorage.clear(); } catch (_) {} });
    page.on('pageerror', error => errors.push(error.message));
    const requested = [];
    page.on('request', req => { if (/^https?:/.test(req.url())) requested.push(req.url()); });
    await page.goto('file://' + path.join(out, 'deliberation-map-preview.html'));
    const frame = page.frameLocator('iframe');
    await frame.locator('#de-round-content h3').first().waitFor();
    const inner = page.frames().find(f => f.parentFrame());
    async function fit() {
      await inner.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const height = await inner.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
      await page.locator('iframe').evaluate((el, h) => { el.style.height = h + 10 + 'px'; }, height);
      await page.setViewportSize({ width:page.viewportSize().width, height:height+42 });
      await inner.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(() => window.scrollTo(0,0));
      await inner.evaluate(() => window.scrollTo(0,0));
    }
    async function widthCheck(label) {
      const sizes = await inner.evaluate(() => ({ w: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert(sizes.scroll <= sizes.w + 1, label + ' overflows: ' + JSON.stringify(sizes));
    }
    for (const r of data.rounds) {
      await frame.locator('[data-round="' + r.id + '"]').click();
      assert((await frame.locator('#de-round-content').innerText()).includes(r.outcome));
      assert.equal(await frame.locator('[data-round="' + r.id + '"]').getAttribute('aria-pressed'), 'true');
      await widthCheck('Round ' + r.id);
    }
    await frame.locator('#de-round-content summary').filter({ hasText:'The six final amendments' }).click();
    assert((await frame.locator('#de-round-content').innerText()).includes(data.amendments[5]));
    await fit();
    await page.screenshot({ path:path.join(__dirname, 'round-3-desktop.png'), fullPage:true });

    await frame.locator('[data-tab="trails"]').click();
    for (const t of data.trails) {
      await frame.locator('#de-trail-select').selectOption(t.id);
      assert((await frame.locator('#de-trail-content').innerText()).includes(t.outcome));
      await widthCheck('Trail ' + t.id);
    }
    await frame.locator('#de-trail-select').selectOption('approval');
    await frame.locator('#de-trail-content details').first().locator('summary').click();
    await frame.locator('#de-trail-content [data-doc]').first().click();
    assert.equal(await frame.locator('#de-panel-evidence').isVisible(), true);
    assert((await frame.locator('#de-source-meta').innerText()).includes(data.sources.c1.path));
    assert((await frame.locator('#de-source-excerpt').innerText()).includes('D4 Cross-assistant'));

    await frame.locator('[data-tab="coverage"]').click();
    for (const status of Object.keys(data.statusDefinitions)) {
      await frame.locator('#de-status-select').selectOption(status);
      assert.equal(await frame.locator('#de-audit-select option').count(), data.audit.filter(a => a.disposition === status).length);
      for (const a of data.audit.filter(a => a.disposition === status)) {
        await frame.locator('#de-audit-select').selectOption(a.id);
        assert((await frame.locator('#de-audit-content').innerText()).includes(a.remaining));
      }
    }
    await frame.locator('#de-status-select').selectOption('Missing');
    await frame.locator('#de-audit-select').selectOption('calendarwrite');
    await fit(); await widthCheck('Coverage desktop');
    await page.screenshot({ path:path.join(__dirname, 'coverage-desktop.png'), fullPage:true });
    await frame.locator('#de-panel-coverage > details').evaluate(el => { el.open = true; });
    assert.equal(await frame.locator('#de-audit-table tbody tr').count(), data.audit.length);
    await frame.locator('[data-show-audit="isolation"]').click();
    assert.equal(await frame.locator('#de-status-select').inputValue(), 'Partial');

    await frame.locator('[data-tab="evidence"]').click();
    for (const [key, source] of Object.entries(data.sources)) {
      await frame.locator('#de-source-select').selectOption(key);
      assert((await frame.locator('#de-source-meta').innerText()).includes(source.sha256));
      assert.equal(await frame.locator('#de-source-full').textContent(), source.text.split('\n').map((line, i) => String(i+1).padStart(3) + '  ' + line).join('\n'));
    }
    await page.setViewportSize({ width:352, height:1000 });
    await page.emulateMedia({ colorScheme:'dark' });
    await frame.locator('[data-tab="rounds"]').click();
    await frame.locator('[data-round="1"]').click();
    await fit(); await widthCheck('Round 1 mobile dark');
    await page.screenshot({ path:path.join(__dirname, 'round-1-mobile-dark.png'), fullPage:true });
    await frame.locator('[data-tab="trails"]').click();
    for (const t of data.trails) { await frame.locator('#de-trail-select').selectOption(t.id); await widthCheck('Mobile trail ' + t.id); }
    await frame.locator('#de-trail-select').selectOption('schema');
    await fit(); await page.screenshot({ path:path.join(__dirname, 'schema-mobile-dark.png'), fullPage:true });
    await frame.locator('[data-tab="coverage"]').click();
    await widthCheck('Coverage mobile');
    await frame.locator('[data-tab="evidence"]').click();
    await widthCheck('Evidence mobile');
    const refs = [];
    function collect(value) {
      if (!value || typeof value !== 'object') return;
      if ('doc' in value && 'line' in value && 'find' in value) refs.push(value);
      for (const v of Object.values(value)) collect(v);
    }
    collect(data);
    for (const r of refs) assert(data.sources[r.doc].text.split('\n')[r.line - 1].toLowerCase().includes(r.find.toLowerCase()));
    console.log('Preview resource requests:', JSON.stringify(requested));
    const runtimeResources = ['https://unpkg.com/@floating-ui/core@1.7.3/dist/floating-ui.core.umd.min.js', 'https://unpkg.com/@floating-ui/dom@1.7.4/dist/floating-ui.dom.umd.min.js', 'https://unpkg.com/lucide@1.17.0/dist/umd/lucide.js'];
    assert(requested.every(url => runtimeResources.includes(url)), 'Only bundled preview dependencies may request remote resources: ' + JSON.stringify(requested));
    assert.deepEqual(errors, []);
    const result = { passed:true, rounds:3, decisionTrails:data.trails.length, concerns:data.audit.length, sources:Object.keys(data.sources).length, checkedReferences:refs.length, widths:[736,320], themes:['light','dark'], browserErrors:errors, remoteRequests:requested };
    fs.writeFileSync(path.join(__dirname, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally { await context.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
