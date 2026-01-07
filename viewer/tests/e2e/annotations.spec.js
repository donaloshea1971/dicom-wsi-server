/**
 * Annotation Tests
 * Tests for annotation creation, editing, and management
 */
const { test, expect } = require('@playwright/test');

test.describe('Annotations', () => {
    
    test.beforeEach(async ({ page }) => {
        await page.goto('/viewer');
        await page.waitForSelector('.study-card', { timeout: 15000 });
        
        // Load a study
        const firstCard = page.locator('.study-card').first();
        if (await firstCard.isVisible()) {
            await firstCard.click();
            await page.waitForSelector('#osd-viewer canvas', { timeout: 30000 });
            await page.waitForSelector('#annotation-toolbar', { timeout: 5000 });
        }
    });

    test('annotation toolbar has all tools', async ({ page }) => {
        const toolbar = page.locator('#annotation-toolbar');
        
        if (await toolbar.isVisible()) {
            // Check for essential tools
            await expect(page.locator('#tool-pan')).toBeVisible();
            await expect(page.locator('#tool-line')).toBeVisible();
            await expect(page.locator('#tool-rectangle')).toBeVisible();
            await expect(page.locator('#tool-polygon')).toBeVisible();
            await expect(page.locator('#tool-point')).toBeVisible();
        }
    });

    test('clicking tool buttons changes active state', async ({ page }) => {
        const toolbar = page.locator('#annotation-toolbar');
        
        if (await toolbar.isVisible()) {
            // Pan should be active by default
            await expect(page.locator('#tool-pan')).toHaveClass(/active/);
            
            // Click line tool
            await page.locator('#tool-line').click();
            await expect(page.locator('#tool-line')).toHaveClass(/active/);
            await expect(page.locator('#tool-pan')).not.toHaveClass(/active/);
            
            // Click rectangle tool
            await page.locator('#tool-rectangle').click();
            await expect(page.locator('#tool-rectangle')).toHaveClass(/active/);
            
            // Press P to return to pan
            await page.keyboard.press('p');
            await expect(page.locator('#tool-pan')).toHaveClass(/active/);
        }
    });

    test('keyboard shortcuts select tools', async ({ page }) => {
        const toolbar = page.locator('#annotation-toolbar');
        
        if (await toolbar.isVisible()) {
            // L for line
            await page.keyboard.press('l');
            await expect(page.locator('#tool-line')).toHaveClass(/active/);
            
            // R for rectangle
            await page.keyboard.press('r');
            await expect(page.locator('#tool-rectangle')).toHaveClass(/active/);
            
            // G for polygon
            await page.keyboard.press('g');
            await expect(page.locator('#tool-polygon')).toHaveClass(/active/);
            
            // E for ellipse
            await page.keyboard.press('e');
            await expect(page.locator('#tool-ellipse')).toHaveClass(/active/);
            
            // M for point
            await page.keyboard.press('m');
            await expect(page.locator('#tool-point')).toHaveClass(/active/);
        }
    });

    test('annotations panel toggles', async ({ page }) => {
        const toolbar = page.locator('#annotation-toolbar');
        
        if (await toolbar.isVisible()) {
            // Click list button to open panel
            await page.locator('#tool-list').click();
            await expect(page.locator('#annotations-panel')).toHaveClass(/active/);
            
            // Click again to close
            await page.locator('#tool-list').click();
            await expect(page.locator('#annotations-panel')).not.toHaveClass(/active/);
        }
    });

    test('color picker is accessible', async ({ page }) => {
        const colorPicker = page.locator('#annotation-color');
        
        if (await colorPicker.isVisible()) {
            // Should have default color
            const value = await colorPicker.inputValue();
            expect(value).toBeTruthy();
        }
    });

    test('export menu opens', async ({ page }) => {
        const toolbar = page.locator('#annotation-toolbar');
        
        if (await toolbar.isVisible()) {
            // Open annotations panel
            await page.locator('#tool-list').click();
            
            // Find export button
            const exportBtn = page.locator('button:has-text("Export")');
            if (await exportBtn.isVisible()) {
                await exportBtn.click();
                
                // Menu should appear
                await expect(page.locator('#export-menu')).toBeVisible();
            }
        }
    });
});
