/**
 * Landing Page Tests (No Authentication Required)
 * Tests the public landing page before login
 */
const { test, expect } = require('@playwright/test');

test.describe('Landing Page', () => {
    
    test('landing page loads', async ({ page }) => {
        await page.goto('/');
        
        // Should have some content
        await expect(page.locator('body')).toBeVisible();
    });

    test('has PathView Pro branding', async ({ page }) => {
        await page.goto('/');
        
        // Look for PathView Pro text anywhere
        const content = await page.content();
        expect(content.toLowerCase()).toContain('pathview');
    });

    test('has login/sign in option', async ({ page }) => {
        await page.goto('/');
        
        // Look for sign in button or link
        const signInBtn = page.locator('text=/sign in|login|get started/i').first();
        await expect(signInBtn).toBeVisible({ timeout: 10000 });
    });

    test('redirects to auth when accessing viewer without login', async ({ page }) => {
        await page.goto('/viewer');
        
        // Should redirect to landing or auth page
        await page.waitForTimeout(2000);
        const url = page.url();
        
        // Either redirected to landing, or has #login hash, or auth0 domain
        const isAuthRedirect = url.includes('auth0') || 
                               url.includes('login') || 
                               url.endsWith('/') ||
                               !url.includes('/viewer');
        
        expect(isAuthRedirect).toBeTruthy();
    });
});
