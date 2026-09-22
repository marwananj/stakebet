const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('BROWSER ERROR:', m.text()); });
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  const email = 'admin' + Date.now() + '@example.com';

  await page.goto('http://localhost:8787/');
  await page.click('#authSeg button[data-i="1"]');
  await page.fill('#su-name', 'Admin E2E');
  await page.fill('#su-dob', '1990-01-01');
  await page.fill('#su-email', email);
  await page.fill('#su-pw', 'password123');
  await page.click('#su-btn');
  await page.waitForSelector('#verifyBox:not(.hide)');
  const code = await page.textContent('#mailCode');
  const otpInputs = await page.$$('#otpRow input');
  for (let i = 0; i < 6; i++) await otpInputs[i].fill(code[i]);
  await page.click('#verifyBtn');
  await page.waitForSelector('#app:not(.hide)');
  console.log('1. Admin account created & logged in (email contains "admin")');

  await page.click('[data-go="admin"]');
  await page.waitForTimeout(1000);
  const adminText = await page.evaluate(() => document.querySelector('#main').textContent.replace(/\s+/g, ' ').slice(0, 300));
  console.log('2. Admin dashboard content:', adminText);

  // switch to basketball, tennis, nfl tabs and confirm they render without error
  for (const sport of ['basketball', 'tennis', 'nfl']) {
    await page.click(`[data-go="${sport}"]`);
    await page.waitForTimeout(600);
    const cnt = await page.$$eval('.match', els => els.length).catch(() => 0);
    console.log(`3. ${sport} board rendered, matches:`, cnt);
  }

  // test parlay mode with two legs across two sports boards
  await page.click('[data-go="football"]');
  await page.waitForTimeout(500);
  await page.evaluate(() => { const b = [...document.querySelectorAll('.o')].find(x => !x.classList.contains('locked')); b && b.click(); });
  await page.click('[data-go="basketball"]');
  await page.waitForTimeout(500);
  await page.evaluate(() => { const b = [...document.querySelectorAll('.o')].find(x => !x.classList.contains('locked')); b && b.click(); });
  await page.evaluate(() => { document.querySelector('.slip-mode button[data-m="parlay"]').click(); });
  await page.waitForTimeout(300);
  const legCount = await page.$$eval('.leg', els => els.length);
  console.log('4. Parlay slip legs:', legCount);
  await page.click('#placeBtn');
  await page.waitForTimeout(1000);
  const toastText = await page.evaluate(() => document.querySelector('.toasts')?.textContent || '');
  console.log('5. Parlay place toast:', toastText);

  await browser.close();
  console.log('DONE');
})().catch((e) => { console.error('E2E FAILED:', e); process.exit(1); });
