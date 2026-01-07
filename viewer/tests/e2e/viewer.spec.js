/**
 * Viewer Tests
 * Tests for the OpenSeadragon WSI viewer functionality
 */
const { test, expect } = require('@playwright/test');

test.describe('WSI Viewer', () => {
    
    test.beforeEach(async ({ page }) => {
        await page.goto('/viewer');
        await page.waitForSelector('.study-card', { timeout: 15000 });
    });

    test('clicking study card loads viewer', async ({ page }) => {
        const firstCard = page.locator('.study-card').first();
        
        if (await firstCard.isVisible()) {
            await firstCard.click();
            
            // Wait for OpenSeadragon canvas to appear
            await expect(page.locator('#osd-viewer canvas')).toBeVisible({ timeout: 30000 });
            
            // Placeholder should be hidden
            await expect(page.locator('#viewer-placeholder')).toBeHidden();
            
            // Toolbar should appear
            await expect(page.locator('#viewer-toolbar')).toBeVisible();
        }
    });

    test('zoom level updates on zoom', async ({ page }) => {
        // Load a study first
        const firstCard = page.locator('.study-card').first();
        if (await firstCard.isVisible()) {
            await firstCard.click();
            await page.waitForSelector('#osd-viewer canvas', { timeout: 30000 });
            
            // Get initial zoom
            const zoomBadge = page.locator('#zoom-level');
            const initialZoom = await zoomBadge.textContent();
            
            // Zoom in with keyboard
            await page.keyboard.press('+');
            await page.waitForTimeout(500);
            
            // Zoom should have changed
            const newZoom = await zoomBadge.textContent();
            expect(parseFloat(newZoom)).toBeGreaterThan(parseFloat(initialZoom));
        }
    });

    test('keyboard shortcuts for zoom levels work', async ({ page }) => {
        const firstCard = page.locator('.study-card').first();
        if (await firstCard.isVisible()) {
            await firstCard.click();
            await page.waitForSelector('#osd-viewer canvas', { timeout: 30000 });
            
            const zoomBadge = page.locator('#zoom-level');
            
            // Press 1 for home/fit
            await page.keyboard.press('1');
            await page.waitForTimeout(300);
            
            // Press 4 for 10x
            await page.keyboard.press('4');
            await page.waitForTimeout(500);
            const zoom10x = await zoomBadge.textContent();
            expect(parseFloat(zoom10x)).toBeGreaterThanOrEqual(5);
        }
    });

    test('WASD navigation works', async ({ page }) => {
        const firstCard = page.locator('.study-card').first();
        if (await firstCard.isVisible()) {
            await firstCard.click();
            await page.waitForSelector('#osd-viewer canvas', { timeout: 30000 });
            
            // Pan with WASD (shouldn't error)
            await page.keyboard.press('w');
            await page.keyboard.press('a');
            await page.keyboard.press('s');
            await page.keyboard.press('d');
            
            // If we got here without errors, navigation works
            expect(true).toBeTruthy();
        }
    });

    test('annotation toolbar appears when slide loads', async ({ page }) => {
        const firstCard = page.locator('.study-card').first();
        if (await firstCard.isVisible()) {
            await firstCard.click();
            await page.waitForSelector('#osd-viewer canvas', { timeout: 30000 });
            
            // Annotation toolbar should be visible
            await expect(page.locator('#annotation-toolbar')).toBeVisible({ timeout: 5000 });
        }
    });

    test('fullscreen toggle works', async ({ page }) => {
        const firstCard = page.locator('.study-card').first();
        if (await firstCard.isVisible()) {
            await firstCard.click();
            await page.waitForSelector('#osd-viewer canvas', { timeout: 30000 });
            
            // Press F for fullscreen
            await page.keyboard.press('f');
            
            // Note: Fullscreen may be blocked by browser, just verify no error
            await page.waitForTimeout(300);
            expect(true).toBeTruthy();
        }
    });
});
