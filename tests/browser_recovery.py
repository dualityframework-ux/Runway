"""Exercise malformed backups, damaged local storage and quota failures in Chromium."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

URL = (Path(__file__).resolve().parents[1] / 'index.html').as_uri()
STATE = {'asOf':'2026-11-01','checking':1000,'floor':100,
         'pay':{'amount':0,'next':'2026-11-01','everyDays':14,'oneOffs':[]},
         'bills':[{'id':'rent','name':'Rent','day':10,'amount':100}],
         'budget':[],'debts':[],'paid':{},'log':[]}

with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    def page_with_saved(raw):
        page = browser.new_page(viewport={'width':390,'height':844})
        page.route('https://**', lambda route:route.abort())
        page.on('pageerror', lambda error:errors.append(str(error)))
        page.goto(URL)
        page.evaluate('(raw)=>localStorage.setItem("runway.v1",raw)', raw)
        page.reload()
        return page

    page = page_with_saved(json.dumps(STATE))
    page.locator('nav.tabs a[href="#setup"]').click()
    previous = page.evaluate('localStorage.getItem("runway.v1")')
    for malformed in ['{broken', json.dumps({**STATE,'debts':{}}), json.dumps({**STATE,'asOf':'2026-02-31'})]:
        page.get_by_label('Restore from backup').fill(malformed)
        page.get_by_role('button',name='Restore',exact=True).click()
        expect(page.locator('#status')).to_contain_text('Your current plan was not changed')
        expect(page.get_by_label('Checking',exact=True)).to_have_value('1000')
        assert page.evaluate('localStorage.getItem("runway.v1")') == previous
    # A valid restore must not report success if durable storage fails.
    page.evaluate('''() => { const original=Storage.prototype.setItem;
        Storage.prototype.setItem=function(key,value){if(key==='runway.v1')throw new Error('quota'); return original.call(this,key,value);}; }''')
    page.get_by_label('Restore from backup').fill(json.dumps({**STATE,'checking':900}))
    page.get_by_role('button',name='Restore',exact=True).click()
    expect(page.locator('#status')).to_contain_text('Could not save the restored plan')
    expect(page.get_by_label('Checking',exact=True)).to_have_value('1000')
    assert page.evaluate('localStorage.getItem("runway.v1")') == previous
    page.close()

    # Bad saved data is shown as recovery, never replaced with sample data or an empty save.
    for raw in ['{broken', json.dumps({**STATE,'pay':[]})]:
        page = page_with_saved(raw)
        expect(page.get_by_role('alert')).to_contain_text('Saved plan needs recovery')
        page.get_by_label('Checking',exact=True).fill('25')
        page.get_by_label('Checking',exact=True).press('Tab')
        page.wait_for_timeout(400)
        assert page.evaluate('localStorage.getItem("runway.v1")') == raw
        page.evaluate("Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true})")
        page.locator('nav.tabs a[href="#plan"]').click()
        page.get_by_role('button',name='Copy original saved data').click()
        expect(page.get_by_label('Restore from backup')).to_have_value(raw)
        page.get_by_label('Restore from backup').fill(json.dumps(STATE))
        page.get_by_role('button',name='Restore',exact=True).click()
        expect(page.get_by_role('alert')).to_have_count(0)
        assert page.evaluate('localStorage.getItem("runway.v1.previous")') == raw
        page.reload()
        expect(page.get_by_label('Checking',exact=True)).to_have_value('1000')
        page.close()

    # If reading storage fails, later edits must not replace an unseen saved plan.
    page = page_with_saved(json.dumps(STATE))
    before = page.evaluate('localStorage.getItem("runway.v1")')
    page.add_init_script("""window.__blockRead=true; const get=Storage.prototype.getItem;
        Storage.prototype.getItem=function(key){if(key==='runway.v1' && window.__blockRead)throw new Error('read blocked');return get.call(this,key);};""")
    page.reload()
    expect(page.get_by_role('alert')).to_contain_text('Saved data unavailable')
    page.evaluate('window.__blockRead=false')
    page.get_by_label('Checking',exact=True).fill('25')
    page.get_by_label('Checking',exact=True).press('Tab')
    page.wait_for_timeout(400)
    assert page.evaluate('localStorage.getItem("runway.v1")') == before
    page.close()

    # A navigation immediately after editing still flushes the last change.
    page = page_with_saved(json.dumps(STATE))
    page.locator('nav.tabs a[href="#setup"]').click()
    page.get_by_label('Checking',exact=True).fill('333')
    page.get_by_label('Checking',exact=True).press('Tab')
    page.reload()
    expect(page.get_by_label('Checking',exact=True)).to_have_value('333')
    page.get_by_role('button',name='Erase everything',exact=True).click()
    page.get_by_role('button',name='Tap again to erase',exact=True).click()
    assert page.evaluate('localStorage.getItem("runway.v1.previous")') is None
    assert page.evaluate('JSON.parse(localStorage.getItem("runway.v1")).bills.length') == 0
    expect(page.get_by_label('Checking',exact=True)).to_have_value('0')
    assert not errors, errors
    browser.close()
print('Recovery browser checks passed: invalid restores, quota failures, original-data recovery, reload, pending edits.')
