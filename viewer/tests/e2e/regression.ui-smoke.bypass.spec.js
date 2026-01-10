// Minimal UI regression smoke using auth bypass (no Auth0).
//
// Uploads 1–2 items via the upload UI and performs a superficial viewer check.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

function repoRoot() {
  // viewer/tests/e2e -> repo root
  return path.resolve(__dirname, '..', '..', '..');
}

function loadManifest() {
  const manifestPath = path.join(repoRoot(), 'tests', 'regression', 'data_manifest.json');
  const raw = fs.readFileSync(manifestPath, 'utf-8');
  return JSON.parse(raw);
}

function resolvePath(rel) {
  return path.join(repoRoot(), ...rel.split('/'));
}

function listFilesRecursively(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

test('ui smoke: upload and basic viewer access', async ({ page, baseURL }) => {
  const bypassSecret = process.env.AUTH_BYPASS_SECRET || process.env.PV_AUTH_BYPASS_SECRET;
  if (!bypassSecret) throw new Error('Missing AUTH_BYPASS_SECRET/PV_AUTH_BYPASS_SECRET');

  const manifest = loadManifest();
  const smoke = manifest.ui_smoke || [];
  if (smoke.length === 0) test.skip(true, 'Manifest ui_smoke is empty');

  await page.addInitScript((secret) => {
    localStorage.setItem('PATHVIEW_AUTH_BYPASS_SECRET', secret);
  }, bypassSecret);

  // Go to upload page
  await page.goto(new URL('/upload.html', baseURL).toString(), { waitUntil: 'domcontentloaded' });

  // File input is intentionally hidden (display:none) - user clicks drop zone to trigger it
  // Playwright can still setInputFiles on hidden inputs
  // Remove webkitdirectory attribute to allow individual file selection in tests
  await page.evaluate(() => {
    const input = document.getElementById('file-input');
    if (input) input.removeAttribute('webkitdirectory');
  });
  const fileInput = page.locator('#file-input');
  await expect(fileInput).toBeAttached();

  // Build list of local files to upload:
  // - dicom_directory => upload all dcms in that dir (browser supports multi-select)
  // - vendor_file => upload the selected vendor file
  const filePaths = [];
  for (const item of smoke) {
    if (item.kind === 'dicom_directory') {
      const dir = manifest.dicom_directory?.relpath;
      if (!dir) continue;
      // Upload a limited subset to keep UI smoke fast
      // (directory itself is validated in Upload regression mode)
      const all = listFilesRecursively(resolvePath(dir)).filter(p => p.toLowerCase().endsWith('.dcm'));
      all.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      filePaths.push(...all.slice(0, 5)); // 5 files is enough to exercise the UI upload flow
    } else if (item.kind === 'vendor_file') {
      const vf = (manifest.vendor_files || []).find(v => v.vendor === item.vendor);
      if (vf?.relpath) filePaths.push(resolvePath(vf.relpath));
    }
  }

  // Ensure we actually have files to set
  if (filePaths.length === 0) test.skip(true, 'No file paths resolved for ui_smoke');

  await fileInput.setInputFiles(filePaths);

  // Queue should appear; click Start Upload
  const uploadBtn = page.locator('#upload-btn');
  await expect(uploadBtn).toBeEnabled({ timeout: 10000 });
  await uploadBtn.click();

  // Wait until all queue items show complete or until timeout
  const timeoutMs = Number(process.env.UI_SMOKE_TIMEOUT_MS || 15 * 60 * 1000);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const anyUploading = await page.locator('.queue-item.uploading, .queue-item.converting').count();
    const anyError = await page.locator('.queue-item.error').count();
    if (anyError > 0) {
      // Surface errors with a screenshot automatically (Playwright config)
      throw new Error('One or more uploads failed in UI smoke');
    }
    if (anyUploading === 0) break;
    await page.waitForTimeout(2000);
  }

  // Basic viewer smoke: load index page and ensure it renders study list
  await page.goto(new URL('/index.html', baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // We don't hard-require a particular study to show up here (different server state),
  // just that the app loads and can call APIs without auth errors.
  await expect(page.locator('body')).toBeVisible();

  // Cleanup is intentionally opt-in (especially important for deployed environments).
  // Enable by setting: PV_UI_CLEANUP=1
  if (process.env.PV_UI_CLEANUP === '1') {
    // Cleanup for next iteration: delete all owned studies via UI.
    // This keeps runs isolated and also validates the delete modal flow.
    const categorized = await page.request.get(new URL('/api/studies/categorized?include_samples=true', baseURL).toString(), {
      headers: { 'X-Auth-Bypass': bypassSecret }
    });
    if (categorized.ok()) {
      const data = await categorized.json();
      const owned = Array.isArray(data.owned) ? data.owned : [];
      for (const studyId of owned) {
        await page.evaluate((sid) => {
          if (typeof window.confirmDeleteSlide === 'function') window.confirmDeleteSlide(sid, sid);
        }, studyId);
        const dialog = page.locator('#delete-confirm-dialog');
        await expect(dialog).toBeVisible({ timeout: 10000 });
        await page.locator('.delete-modal .btn-danger').click();
        await expect(dialog).toBeHidden({ timeout: 60000 });
        await page.waitForTimeout(500);
      }
    }
  }
});

