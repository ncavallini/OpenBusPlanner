import { expect, test } from '@playwright/test';

/**
 * Runs against the real web app + API + database seeded with the synthetic fixtures
 * (`pnpm db:seed`). `scope=synthetic` keeps results deterministic even when real feeds
 * are imported as well.
 */
const SCENARIO =
  '/?from=city:ch-zurich&fromName=Z%C3%BCrich&to=city:it-bolzano&toName=Bolzano&mode=arrive&date=2026-11-08&wf=04:00&wt=08:00&maxTransfers=3&nbd=2026-11-07&nbt=12:00&scope=synthetic';

test('arrival search Zurich → Bolzano shows the exact fixture itineraries', async ({ page }) => {
  await page.goto(SCENARIO);
  const cards = page.getByTestId('itinerary');
  await expect(cards).toHaveCount(4);
  await expect(page.getByTestId('result-count')).toHaveText('4 of 4 itineraries');
  await expect(page.getByTestId('coverage-message')).toContainText('synthetic test data');
  await expect(page.getByTestId('synthetic-badge').first()).toBeVisible();

  await page.getByTestId('sort-select').selectOption('departure');
  await expect(cards.first()).toContainText('15:00');
  await expect(cards.first()).toContainText('04:10');
  await expect(cards.first()).toContainText('2 transfers');
  await expect(cards.last()).toContainText('23:30');
  await expect(cards.last()).toContainText('Direct');
});

test('itinerary details show legs, transfer quality, separate tickets and provenance', async ({ page }) => {
  await page.goto(SCENARIO);
  await page.getByTestId('sort-select').selectOption('departure');
  const viaMilan = page.getByTestId('itinerary').filter({ hasText: '19:00' });
  await viaMilan.getByTestId('toggle-details').click();
  const details = viaMilan.getByTestId('itinerary-details');
  await expect(details).toContainText('Fixture Bus Bravo (synthetic)');
  await expect(details).toContainText('Fixture Lines Charlie (synthetic)');
  await expect(details.getByTestId('connection')).toContainText('Comfortable');
  await expect(details.getByTestId('warning-separate_tickets')).toBeVisible();
  await expect(details).toContainText('Synthetic test fixture');
  await expect(details.getByTestId('provenance').first()).toContainText('SYNTHETIC FIXTURE');
  await expect(details).toContainText('Synthetic test data — not bookable');
});

test('walking transfer and alternative corridor are labelled', async ({ page }) => {
  await page.goto(SCENARIO);
  const viaInnsbruck = page.getByTestId('itinerary').filter({ hasText: '2 transfers' });
  await viaInnsbruck.getByTestId('toggle-details').click();
  await expect(viaInnsbruck.getByTestId('itinerary-details')).toContainText('walk');
  await expect(page.getByTestId('itinerary').filter({ hasText: 'Alternative via other cities' })).toHaveCount(1);
});

test('comparison table for two itineraries', async ({ page }) => {
  await page.goto(SCENARIO);
  const boxes = page.getByLabel('Add to comparison');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await expect(page.getByTestId('compare-table')).toContainText('Weakest connection');
});

test('empty state distinguishes "no journey in available data"', async ({ page }) => {
  await page.goto(SCENARIO.replace('wf=04:00&wt=08:00', 'wf=10:00&wt=11:00'));
  await expect(page.getByTestId('empty-state')).toContainText('No journey found in the available data');
  await expect(page.getByTestId('empty-state')).toContainText('does not prove that no journey exists');
});

test('autocomplete resolves multilingual aliases and runs a search', async ({ page }) => {
  await page.goto('/?scope=synthetic');
  await page.getByTestId('origin-input').fill('Zurigo');
  await page.getByRole('option', { name: /Zürich/ }).first().click();
  await page.getByTestId('destination-input').fill('Bozen');
  await page.getByRole('option', { name: /Bolzano/ }).first().click();
  await page.getByRole('radio', { name: 'Arrival' }).click();
  await page.getByTestId('date-input').fill('2026-11-08');
  await page.getByTestId('window-select').selectOption({ label: 'Early morning (04–08)' });
  await page.getByTestId('search-button').click();
  await expect(page).toHaveURL(/mode=arrive/);
  await expect(page.getByTestId('itinerary').first()).toBeVisible();
});

test('data sources page distinguishes synthetic and real sources', async ({ page }) => {
  await page.goto('/sources');
  const sources = page.getByTestId('sources');
  await expect(sources).toContainText('SYNTHETIC FIXTURE: Zurich–Bolzano test network');
  await expect(sources.getByText('Synthetic').first()).toBeVisible();
  await expect(sources).toContainText('Adapter not implemented');
});
