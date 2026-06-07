import { test, expect } from '@playwright/test';

// E2E smoke tests for sign-in gating and mobile layout.
// Requires: `npm run preview` (or `npm run dev`) serving the built app.
// Viewport is set to mobile in playwright.config.ts (Pixel 5 / iPhone 13).

test.describe('Auth gate (mobile)', () => {
  test('unauthenticated: shows sign-in page, not device list', async ({ page }) => {
    // The app queries /api/me from the relay; since the relay is not running in CI,
    // intercept and return 401 to simulate no session.
    await page.route('**/api/me', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthenticated' }) }),
    );

    await page.goto('/');

    await expect(page.getByTestId('login-page')).toBeVisible();
    await expect(page.getByTestId('google-signin-btn')).toBeVisible();
    await expect(page.getByTestId('device-list')).not.toBeVisible();
  });

  test('login page: sign-in button meets 44px touch target minimum', async ({ page }) => {
    await page.route('**/api/me', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthenticated' }) }),
    );

    await page.goto('/');
    await expect(page.getByTestId('login-page')).toBeVisible();

    const btn = page.getByTestId('google-signin-btn');
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  });

  test('authenticated: shows device list', async ({ page }) => {
    await page.route('**/api/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ userId: 'u1', email: 'test@example.com' }),
      }),
    );
    await page.route('**/api/devices', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ devices: [] }),
      }),
    );
    // Intercept WS ticket to prevent real WS connection attempts
    await page.route('**/api/ws-ticket', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'ok' }) }),
    );

    await page.goto('/');

    await expect(page.getByTestId('device-list')).toBeVisible();
    await expect(page.getByTestId('login-page')).not.toBeVisible();
  });

  test('add-device button meets touch target minimum', async ({ page }) => {
    await page.route('**/api/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ userId: 'u1', email: 'test@example.com' }),
      }),
    );
    await page.route('**/api/devices', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ devices: [] }) }),
    );
    await page.route('**/api/ws-ticket', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({}) }),
    );

    await page.goto('/');
    await expect(page.getByTestId('device-list')).toBeVisible();

    const btn = page.getByTestId('add-device-btn');
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});
