const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const email = 'e2e' + Date.now() + '@example.com';
  page.on('console', (m) => { if (m.type() === 'error') console.log('BROWSER ERROR:', m.text()); });
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

  await page.goto('http://localhost:8787/');
  console.log('1. Loaded landing page, title:', await page.title());

  // Switch to signup
  await page.click('#authSeg button[data-i="1"]');
  await page.fill('#su-name', 'E2E Tester');
  await page.fill('#su-dob', '1995-05-05');
  await page.fill('#su-email', email);
  await page.fill('#su-pw', 'password123');
  await page.click('#su-btn');
  await page.waitForSelector('#verifyBox:not(.hide)', { timeout: 5000 });
  const code = await page.textContent('#mailCode');
  console.log('2. Signed up, got code:', code);

  const otpInputs = await page.$$('#otpRow input');
  for (let i = 0; i < 6; i++) await otpInputs[i].fill(code[i]);
  await page.click('#verifyBtn');
  await page.waitForSelector('#app:not(.hide)', { timeout: 5000 });
  console.log('3. Verified & logged in, app shell visible');

  await page.waitForFunction(() => document.querySelector('#balanceAmt').textContent !== '$0.00', { timeout: 5000 });
  const bal1 = await page.textContent('#balanceAmt');
  console.log('4. Balance after welcome bonus:', bal1);

  await page.waitForSelector('.match', { timeout: 8000 });
  const matchCount = await page.$$eval('.match', (els) => els.length);
  console.log('5. Football matches rendered:', matchCount);

  // find an open (non-locked, non-closed) odds button and click it
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.o')].filter((b) => !b.classList.contains('locked'));
    if (!btns.length) return false;
    btns[0].click();
    return true;
  });
  console.log('6. Clicked an odds button:', clicked);
  await page.waitForSelector('.leg', { timeout: 3000 });
  console.log('7. Slip shows a leg');

  await page.click('#placeBtn');
  await page.waitForTimeout(1200);
  const toastText = await page.evaluate(() => document.querySelector('.toasts')?.textContent || '');
  console.log('8. Toast after placing bet:', toastText);

  await page.click('[data-go="bets"]');
  await page.waitForTimeout(500);
  const betsHtml = await page.evaluate(() => document.querySelector('#main').textContent.slice(0, 200));
  console.log('9. Bets page shows:', betsHtml.replace(/\s+/g, ' '));

  const bal2 = await page.textContent('#balanceAmt');
  console.log('10. Balance after placing bet:', bal2);

  // reload to prove state is server-side, not localStorage
  await page.reload();
  await page.waitForSelector('#app:not(.hide)', { timeout: 5000 });
  const bal3 = await page.textContent('#balanceAmt');
  console.log('11. Balance survives full page reload (server-backed):', bal3);

  await browser.close();
  console.log('DONE - all steps completed without throwing');
})().catch((e) => { console.error('E2E FAILED:', e); process.exit(1); });
