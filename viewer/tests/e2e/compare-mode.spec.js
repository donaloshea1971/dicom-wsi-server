/**
 * Compare Mode Tests
 * Tests for dual-viewer comparison functionality
 */
const { test, expect } = require('@playwright/test');

test.describe('Compare Mode', () => {
    
    test.beforeEach(async ({ page }) => {
        await page.goto('/viewer');
        await page.waitForSelector('.study-card', { timeout: 15000 });
    });

    test('compare button exists on study cards', async ({ page }) => {
        const cards = await page.locator('.study-card').count();
        
        if (cards > 0) {
            const compareBtn = page.locator('.study-card .compare-btn').first();
            await expect(compareBtn).toBeVisible();
        }
    });

    test('clicking compare button enters compare mode', async ({ page }) => {
        const cards = await page.locator('.study-card').count();
        
        if (cards > 0) {
            // Click compare button on first card
            await page.locator('.study-card .compare-btn').first().click();
            
            // Container should have compare-mode class
            await expect(page.locator('.viewer-container')).toHaveClass(/compare-mode/);
            
            // Compare toolbar should be visible
            await expect(page.locator('#compare-toolbar')).toBeVisible();
        }
    });

    test('compare toolbar has controls', async ({ page }) => {
        const cards = await page.locator('.study-card').count();
        
        if (cards > 0) {
            // Enter compare mode
            await page.locator('.study-card .compare-btn').first().click();
            await expect(page.locator('#compare-toolbar')).toBeVisible();
            
            // Check for sync nav button
            await expect(page.locator('#sync-nav-btn')).toBeVisible();
            
            // Check for swap button
            await expect(page.locator('button:has-text("Swap")')).toBeVisible();
            
            // Check for close button
            await expect(page.locator('button:has-text("Close")')).toBeVisible();
        }
    });

    test('sync navigation toggles', async ({ page }) => {
        const cards = await page.locator('.study-card').count();
        
        if (cards > 0) {
            await page.locator('.study-card .compare-btn').first().click();
            await expect(page.locator('#compare-toolbar')).toBeVisible();
            
            const syncBtn = page.locator('#sync-nav-btn');
            
            // Toggle sync
            await syncBtn.click();
            await expect(syncBtn).toHaveClass(/active/);
            
            // Toggle off
            await syncBtn.click();
            await expect(syncBtn).not.toHaveClass(/active/);
        }
    });

    test('exit compare mode works', async ({ page }) => {
        const cards = await page.locator('.study-card').count();
        
        if (cards > 0) {
            // Enter compare mode
            await page.locator('.study-card .compare-btn').first().click();
            await expect(page.locator('.viewer-container')).toHaveClass(/compare-mode/);
            
            // Click close
            await page.locator('button:has-text("Close")').click();
            
            // Should exit compare mode
            await expect(page.locator('.viewer-container')).not.toHaveClass(/compare-mode/);
            await expect(page.locator('#compare-toolbar')).not.toBeVisible();
        }
    });
});
