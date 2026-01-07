/**
 * UI Elements Tests
 * Tests for general UI components, modals, and interactions
 */
const { test, expect } = require('@playwright/test');

test.describe('UI Elements', () => {
    
    test.beforeEach(async ({ page }) => {
        await page.goto('/viewer');
    });

    test('header is visible with logo', async ({ page }) => {
        await expect(page.locator('header.header')).toBeVisible();
        await expect(page.locator('.logo')).toBeVisible();
        await expect(page.locator('.logo')).toContainText('PathView Pro');
    });

    test('user menu is visible when logged in', async ({ page }) => {
        await expect(page.locator('#user-menu')).toBeVisible({ timeout: 10000 });
    });

    test('user dropdown toggles', async ({ page }) => {
        await expect(page.locator('#user-menu')).toBeVisible({ timeout: 10000 });
        
        // Click user button
        await page.locator('.user-btn').click();
        await expect(page.locator('#user-dropdown')).toHaveClass(/active/);
        
        // Click outside to close
        await page.click('body', { position: { x: 10, y: 10 } });
        await expect(page.locator('#user-dropdown')).not.toHaveClass(/active/);
    });

    test('keyboard help toggle works', async ({ page }) => {
        // Press ? to show help
        await page.keyboard.press('?');
        await expect(page.locator('#keyboard-help')).toBeVisible();
        
        // Press Escape to close
        await page.keyboard.press('Escape');
        await expect(page.locator('#keyboard-help')).toBeHidden();
    });

    test('help badge opens keyboard help', async ({ page }) => {
        const helpBadge = page.locator('#help-badge');
        await expect(helpBadge).toBeVisible();
        
        await helpBadge.click();
        await expect(page.locator('#keyboard-help')).toBeVisible();
    });

    test('status bar badges are present', async ({ page }) => {
        await expect(page.locator('#zoom-level')).toBeVisible();
        await expect(page.locator('#help-badge')).toBeVisible();
    });

    test('sidebar is visible', async ({ page }) => {
        await expect(page.locator('.sidebar')).toBeVisible();
        await expect(page.locator('.sidebar-header')).toBeVisible();
    });

    test('upload button exists', async ({ page }) => {
        const uploadBtn = page.locator('button:has-text("Upload")');
        await expect(uploadBtn).toBeVisible();
    });
});

test.describe('Modals', () => {
    
    test.beforeEach(async ({ page }) => {
        await page.goto('/viewer');
        await page.waitForSelector('.study-card', { timeout: 15000 });
        
        // Load a study to enable metadata
        const firstCard = page.locator('.study-card').first();
        if (await firstCard.isVisible()) {
            await firstCard.click();
            await page.waitForSelector('#osd-viewer canvas', { timeout: 30000 });
        }
    });

    test('metadata modal opens and closes', async ({ page }) => {
        // Click info button in toolbar
        const infoBtn = page.locator('.toolbar-btn[title="Image Info"]');
        if (await infoBtn.isVisible()) {
            await infoBtn.click();
            await expect(page.locator('#metadata-modal')).toHaveClass(/active/);
            
            // Close button
            await page.locator('#metadata-modal .modal-close').click();
            await expect(page.locator('#metadata-modal')).not.toHaveClass(/active/);
        }
    });

    test('color panel opens and closes', async ({ page }) => {
        // Click color badge
        const colorBadge = page.locator('#color-badge');
        if (await colorBadge.isVisible()) {
            await colorBadge.click();
            await expect(page.locator('#color-panel')).toHaveClass(/active/);
            
            // Close button
            await page.locator('#color-panel .modal-close').click();
            await expect(page.locator('#color-panel')).not.toHaveClass(/active/);
        }
    });

    test('color panel has controls', async ({ page }) => {
        const colorBadge = page.locator('#color-badge');
        if (await colorBadge.isVisible()) {
            await colorBadge.click();
            
            // Check for sliders
            await expect(page.locator('#gamma-slider')).toBeVisible();
            await expect(page.locator('#brightness-slider')).toBeVisible();
            await expect(page.locator('#contrast-slider')).toBeVisible();
            await expect(page.locator('#saturation-slider')).toBeVisible();
            
            // Check for preset dropdown
            await expect(page.locator('#color-preset')).toBeVisible();
        }
    });
});
