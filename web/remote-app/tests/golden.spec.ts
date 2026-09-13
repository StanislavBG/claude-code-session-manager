import { test, expect } from '@playwright/test';

// Golden-path gate for the Bilko publish pipeline (host-contract §Publish gate).
// The app gates behind Clerk sign-in; the golden check only asserts the app shell
// boots and the brand title is present (matches manifest.golden.expect).
test('boots and shows the Session Manager brand', async ({ page }) => {
  await page.goto('/projects/session-manager/');
  await expect(page).toHaveTitle(/Session Manager/);
});
