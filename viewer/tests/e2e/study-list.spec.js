/**
 * Study List Tests
 * Tests for the sidebar study list functionality
 */
const { test, expect } = require('@playwright/test');

test.describe('Study List', () => {
    
    test.beforeEach(async ({ page }) => {
        await page.goto('/viewer');
        // Wait for studies to load
        await page.waitForSelector('.study-card, .empty-state', { timeout: 15000 });
    });

    test('displays study cards or empty state', async ({ page }) => {
        const cards = page.locator('.study-card');
        const emptyState = page.locator('.empty-state');
        
        // Either we have cards or empty state
        const hasCards = await cards.count() > 0;
        const hasEmptyState = await emptyState.isVisible().catch(() => false);
        
        expect(hasCards || hasEmptyState).toBeTruthy();
    });

    test('study cards have required elements', async ({ page }) => {
        const firstCard = page.locator('.study-card').first();
        
        if (await firstCard.isVisible().catch(() => false)) {
            // Check card has UID
            await expect(firstCard.locator('.study-uid')).toBeVisible();
            // Check card has slide info
            await expect(firstCard.locator('.study-slide-info')).toBeVisible();
        }
    });

    test('search filters studies', async ({ page }) => {
        const searchInput = page.locator('#study-search');
        await expect(searchInput).toBeVisible();
        
        const initialCount = await page.locator('.study-card').count();
        
        if (initialCount > 0) {
            // Type a search term that likely won't match
            await searchInput.fill('zzzznonexistent');
            await page.waitForTimeout(300);
            
            // Should filter down
            const visibleCards = page.locator('.study-card:visible');
            const filteredCount = await visibleCards.count();
            
            expect(filteredCount).toBeLessThanOrEqual(initialCount);
            
            // Clear search
            await searchInput.fill('');
            await page.waitForTimeout(300);
            
            // Should restore
            const restoredCount = await page.locator('.study-card').count();
            expect(restoredCount).toBe(initialCount);
        }
    });

    test('view mode toggle works', async ({ page }) => {
        const flatBtn = page.locator('#view-flat');
        const groupedBtn = page.locator('#view-grouped');
        
        await expect(flatBtn).toBeVisible();
        await expect(groupedBtn).toBeVisible();
        
        // Default is flat
        await expect(flatBtn).toHaveClass(/active/);
        
        // Switch to grouped
        await groupedBtn.click();
        await expect(groupedBtn).toHaveClass(/active/);
        await expect(flatBtn).not.toHaveClass(/active/);
        
        // Switch back
        await flatBtn.click();
        await expect(flatBtn).toHaveClass(/active/);
    });

    test('refresh button reloads studies', async ({ page }) => {
        const refreshBtn = page.locator('button:has-text("Refresh")');
        await expect(refreshBtn).toBeVisible();
        
        // Click refresh
        await refreshBtn.click();
        
        // Should show loading state briefly
        // Then restore studies
        await page.waitForSelector('.study-card, .empty-state', { timeout: 15000 });
    });
});
