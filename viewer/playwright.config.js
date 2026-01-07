// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * PathView Pro Viewer - Playwright Configuration
 * @see https://playwright.dev/docs/test-configuration
 */
module.exports = defineConfig({
  testDir: './tests/e2e',
  
  /* Run tests in files in parallel */
  fullyParallel: true,
  
  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,
  
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  
  /* Opt out of parallel tests on CI */
  workers: process.env.CI ? 1 : undefined,
  
  /* Reporter to use */
  reporter: [
    ['html', { open: 'never' }],
    ['list']
  ],
  
  /* Shared settings for all projects */
  use: {
    /* Base URL for navigation */
    baseURL: process.env.TEST_URL || 'https://pathviewpro.com',
    
    /* Collect trace when retrying the failed test */
    trace: 'on-first-retry',
    
    /* Screenshot on failure */
    screenshot: 'only-on-failure',
    
    /* Video on failure */
    video: 'retain-on-failure',
    
    /* Viewport size */
    viewport: { width: 1920, height: 1080 },
    
    /* Ignore HTTPS errors (for local dev) */
    ignoreHTTPSErrors: true,
  },

  /* Configure projects for major browsers */
  projects: [
    /* Setup project - handles authentication */
    {
      name: 'setup',
      testMatch: /.*\.setup\.js/,
    },
    
    /* Authenticated tests (requires login) */
    {
      name: 'chromium',
      use: { 
        ...devices['Desktop Chrome'],
        /* Use saved auth state */
        storageState: 'tests/e2e/.auth/user.json',
      },
      dependencies: ['setup'],
    },
    
    /* No-auth tests (landing page, public features) */
    {
      name: 'no-auth',
      use: { 
        ...devices['Desktop Chrome'],
      },
      testMatch: /.*\.noauth\.spec\.js/,
    },

    /* Uncomment to test on Firefox and Safari */
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },
  ],

  /* Run local dev server before starting the tests (optional) */
  // webServer: {
  //   command: 'docker compose up -d',
  //   url: 'http://localhost',
  //   reuseExistingServer: !process.env.CI,
  // },
});
