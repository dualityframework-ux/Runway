"""Spending date field shows its whole value, budget vs. actual fits, and the footer links back to the portfolio."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
# Width the date input needs at its natural size, measured in the page's own fonts.
NATURAL = '''el => { const c = el.cloneNode(); c.style.width = "auto"; c.style.position = "absolute";
  document.body.appendChild(c); const w = c.getBoundingClientRect().width; c.remove(); return w; }'''

with sync_playwright() as p:
    options = {'executable_path': os.environ['CHROME']} if os.environ.get('CHROME') else {}
    browser = p.chromium.launch(**options)
    for width in (320, 390, 1100):
        page = browser.new_page(viewport={'width': width, 'height': 844})
        page.route('https://**', lambda route: route.abort())
        page.goto((ROOT / 'index.html').as_uri())
        page.locator('nav.tabs a[href="#spend"]').click()
        date = page.locator('#sd')
        expect(date).to_be_visible()
        need, have = date.evaluate(NATURAL), date.bounding_box()['width']
        assert have >= need, f'Date field is {have:.0f}px but needs {need:.0f}px at {width}px'
        assert page.evaluate('document.documentElement.scrollWidth') <= width
        expect(page.get_by_role('heading', name='Budget vs. actual')).to_be_visible()
        expect(page.locator('table.bva tbody tr')).to_have_count(5)  # four sample categories plus the total
        assert page.locator('table.bva').bounding_box()['width'] <= width
        link = page.locator('footer.by').get_by_role('link', name='Ian Kachadorian')
        expect(link).to_have_attribute('href', 'https://dualityframework-ux.github.io/duality-framework/')
        page.close()
    browser.close()
print('Layout checks passed: full spending date and budget vs. actual at 320/390/1100px, footer links to the portfolio.')
