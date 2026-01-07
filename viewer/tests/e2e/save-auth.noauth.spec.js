/**
 * Save Auth State Helper
 * Run this to log in manually and save your auth state for future test runs
 * 
 * Usage: npx playwright test save-auth.js --project=no-auth --headed
 */
const { test } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const authFile = path.join(__dirname, '.auth/user.json');

test('save auth state (manual login)', async ({ page }) => {
    test.setTimeout(300000); // 5 minute timeout for manual login
    // Ensure auth directory exists
    const authDir = path.dirname(authFile);
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }

    console.log('\n========================================');
    console.log('MANUAL LOGIN REQUIRED');
    console.log('========================================');
    console.log('1. A browser will open to pathviewpro.com');
    console.log('2. Log in with Google or Microsoft');
    console.log('3. Wait until you see the viewer page');
    console.log('4. The test will auto-detect login and save state');
    console.log('========================================\n');

    // Go to landing page
    await page.goto('/');
    
    // Give user time to see instructions
    await page.waitForTimeout(2000);
    
    console.log('⏳ Waiting for you to log in... (5 minute timeout)');
    
    // Wait for redirect to /viewer (meaning login completed)
    try {
        await page.waitForURL('**/viewer**', { timeout: 300000 }); // 5 minutes
        
        // Extra wait to ensure cookies/storage are fully set
        await page.waitForTimeout(3000);
        
        // Verify we see user menu (confirms login)
        await page.waitForSelector('#user-menu', { timeout: 10000 });
        
        console.log('✅ Login detected!');
        
        // Save the auth state
        await page.context().storageState({ path: authFile });
        
        console.log(`✅ Auth state saved to: ${authFile}`);
        console.log('\nYou can now run authenticated tests with:');
        console.log('  npm test');
        console.log('  npm run test:headed');
        
    } catch (e) {
        console.error('❌ Login timed out or failed');
        console.error('   Please try again and complete login within 5 minutes');
        throw e;
    }
});
