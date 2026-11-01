"""Exercise debt scheduling and restore through the real browser UI."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
state = {
    'asOf': '2026-11-01', 'checking': 1000, 'floor': 0,
    'pay': {'amount': 0, 'next': '2026-11-01', 'everyDays': 14, 'oneOffs': []},
    'bills': [{'id': 'bill', 'name': 'Card bill', 'day': 15, 'amount': 100}],
    'budget': [], 'debts': [{'id': 'card', 'name': 'Card', 'balance': 1000, 'apr': 0, 'payment': 100}],
    'paid': {}, 'log': [],
}
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 390, 'height': 844})
    page.route('https://**', lambda route: route.abort())
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto((ROOT / 'index.html').as_uri())
    page.evaluate('(state) => { localStorage.setItem("runway.v1", JSON.stringify(state)); }', state)
    page.reload()
    expect(page.get_by_text('Forecast incomplete:', exact=False)).to_be_visible()
    page.get_by_role('link', name='Finish payment setup').click()
    page.get_by_label('Payment in cash forecast').select_option('bill')
    page.locator('nav.tabs a[href="#plan"]').click()
    expect(page.get_by_text('Forecast incomplete:', exact=False)).to_have_count(0)
    expect(page.get_by_text('estimated room after scheduled payments')).to_be_visible()
    expect(page.locator('#view .row').filter(has_text='Card bill')).to_have_count(2)
    page.locator('nav.tabs a[href="#bills"]').click()
    page.locator('input[data-act="paid"][data-id="bill"]').check()
    page.locator('nav.tabs a[href="#plan"]').click()
    expect(page.locator('#view .row').filter(has_text='Card bill')).to_have_count(1)

    page.locator('nav.tabs a[href="#setup"]').click()
    page.get_by_label('Payment in cash forecast').select_option('')
    page.get_by_label('Payment due day (1–31)').fill('20')
    page.get_by_label('Payment due day (1–31)').press('Tab')
    # Wait for the normal debounce to persist, then check an actual reload.
    page.wait_for_function('JSON.parse(localStorage.getItem("runway.v1")).debts[0].dueDay === "20"')
    page.reload()
    expect(page.get_by_label('Payment due day (1–31)')).to_have_value('20')
    page.locator('nav.tabs a[href="#bills"]').click()
    page.locator('input[data-act="paid"][data-id="debt:card"]').check()
    page.locator('nav.tabs a[href="#plan"]').click()
    expect(page.locator('#view .row').filter(has_text='Card payment')).to_have_count(1)

    page.locator('nav.tabs a[href="#setup"]').click()
    page.get_by_label('Restore from backup').fill(json.dumps(state))
    page.get_by_role('button', name='Restore', exact=True).click()
    page.locator('nav.tabs a[href="#plan"]').click()
    expect(page.get_by_text('Forecast incomplete:', exact=False)).to_be_visible()
    assert not errors, errors
    browser.close()
print('Browser checks passed: migration warning, linked payment, paid checklist, separate date, reload, restore.')
