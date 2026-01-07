# PathView Pro - E2E Tests

End-to-end tests for the PathView Pro WSI viewer using Playwright.

## Setup

```bash
cd viewer
npm install
npx playwright install
```

## Running Tests

```bash
# Run all tests (headless)
npm test

# Run with browser visible
npm run test:headed

# Run with Playwright UI (great for debugging)
npm run test:ui

# Run in debug mode (step through)
npm run test:debug

# View test report after run
npm run test:report
```

## Authentication

Tests require authentication. Two options:

### Option 1: Manual Login (First Time)
1. Run `npm test` 
2. Browser opens to login page
3. Log in manually within 2 minutes
4. Auth state is saved for future runs

### Option 2: Environment Variables
```bash
# Set credentials
export TEST_USER_EMAIL="your-test-email@example.com"
export TEST_USER_PASSWORD="your-test-password"

# Or in PowerShell
$env:TEST_USER_EMAIL = "your-test-email@example.com"
$env:TEST_USER_PASSWORD = "your-test-password"

npm test
```

## Test Structure

```
tests/e2e/
├── auth.setup.js      # Authentication setup (runs first)
├── study-list.spec.js # Study list/sidebar tests
├── viewer.spec.js     # OpenSeadragon viewer tests
├── annotations.spec.js# Annotation tool tests
├── compare-mode.spec.js# Dual-viewer compare tests
├── ui-elements.spec.js# General UI tests
└── .auth/             # Saved auth state (gitignored)
```

## Writing New Tests

```javascript
const { test, expect } = require('@playwright/test');

test.describe('My Feature', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/viewer');
    });

    test('does something', async ({ page }) => {
        await page.click('.some-button');
        await expect(page.locator('.result')).toBeVisible();
    });
});
```

## Test Generation

Record new tests interactively:
```bash
npm run test:codegen
```

## Running Against Local

```bash
# Set local URL
TEST_URL=http://localhost npm test
```

## CI/CD Integration

```yaml
# GitHub Actions example
- name: Install Playwright
  run: cd viewer && npm ci && npx playwright install --with-deps

- name: Run E2E Tests
  run: cd viewer && npm test
  env:
    TEST_USER_EMAIL: ${{ secrets.TEST_USER_EMAIL }}
    TEST_USER_PASSWORD: ${{ secrets.TEST_USER_PASSWORD }}
```

## Tips

- **Slow tests?** Tests wait for tiles to load. WSI images are large.
- **Flaky tests?** Increase timeouts or add `await page.waitForTimeout()`
- **Screenshots?** Check `test-results/` on failure
- **Video?** Enabled on failure, check `test-results/`
