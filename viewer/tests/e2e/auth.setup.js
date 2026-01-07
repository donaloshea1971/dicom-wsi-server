/**
 * Authentication Setup
 * Logs in once and saves the auth state for all tests to reuse
 */
const { test: setup, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const authFile = path.join(__dirname, '.auth/user.json');

setup('authenticate', async ({ page }) => {
    // Ensure auth directory exists
    const authDir = path.dirname(authFile);
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }

    // Skip if auth state already exists and is valid
    if (fs.existsSync(authFile)) {
        try {
            const authData = JSON.parse(fs.readFileSync(authFile, 'utf8'));
            if (authData.cookies && authData.cookies.length > 0) {
                console.log('✅ Using existing auth state from:', authFile);
                return; // Skip login - auth already saved
            }
        } catch (e) {
            console.log('⚠️  Auth file exists but invalid, will re-authenticate');
        }
    }

    // Check if we have test credentials in environment
    const testEmail = process.env.TEST_USER_EMAIL;
    const testPassword = process.env.TEST_USER_PASSWORD;
    
    if (!testEmail || !testPassword) {
        console.log('⚠️  No test credentials provided.');
        console.log('   Set TEST_USER_EMAIL and TEST_USER_PASSWORD environment variables.');
        console.log('   Or manually log in when the browser opens...');
        
        // Go to login page and wait for manual login
        await page.goto('/');
        
        // Wait for user to complete login (max 2 minutes)
        await page.waitForURL('**/viewer**', { timeout: 120000 });
        
        console.log('✅ Login detected, saving auth state...');
    } else {
        // Automated login with Auth0
        await page.goto('/');
        
        // Click login button
        await page.click('text=Sign In');
        
        // Wait for Auth0 login page
        await page.waitForURL(/.*auth0.com.*/);
        
        // Fill credentials
        await page.fill('input[name="username"], input[type="email"]', testEmail);
        await page.fill('input[name="password"], input[type="password"]', testPassword);
        
        // Submit
        await page.click('button[type="submit"]');
        
        // Wait for redirect back to app
        await page.waitForURL('**/viewer**', { timeout: 30000 });
        
        console.log('✅ Automated login successful');
    }
    
    // Verify we're logged in
    await expect(page.locator('#user-menu')).toBeVisible({ timeout: 10000 });
    
    // Save authentication state
    await page.context().storageState({ path: authFile });
    console.log(`✅ Auth state saved to ${authFile}`);
});
