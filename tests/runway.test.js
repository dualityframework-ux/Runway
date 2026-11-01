// Run with: node tests/runway.test.js
// Loads the app's script from index.html in a minimal fake browser, then tests the planning logic.
const fs = require("fs"), vm = require("vm"), path = require("path"), assert = require("assert");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const code = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];

// Just enough DOM for the app to boot without errors.
const el = () => ({ innerHTML: "", textContent: "", hidden: false, value: "", classList: { toggle() {}, add() {}, remove() {} },
  appendChild() {}, remove() {}, setAttribute() {}, focus() {}, querySelector: () => el(), querySelectorAll: () => [] });
const store = {};
const sandbox = {
  window: { __RUNWAY_TEST__: true, addEventListener() {}, scrollY: 0, scrollTo() {} },
  document: { querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, createElement: () => el(), body: el() },
  localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  location: { hash: "" }, navigator: {}, setTimeout, clearTimeout, console, Date, Math, JSON, Intl,
};
sandbox.window.document = sandbox.document;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const R = sandbox.window.__runway;
assert.ok(R, "test hook is exposed");

// Objects created inside the sandbox have their own Array prototype; compare plain copies.
const plain = x => JSON.parse(JSON.stringify(x));
let passed = 0;
const test = (name, fn) => { fn(); passed++; };

// ---------- forecast ----------
test("forecast walks bills, paychecks and daily spending", () => {
  R.set({ asOf: "2026-11-01", checking: 1000, floor: 0, pay: { amount: 500, next: "2026-11-15", everyDays: 14, oneOffs: [] },
    bills: [{ id: "a", name: "Rent", day: 10, amount: 600 }], budget: [], debts: [], paid: {}, log: [] });
  const p = R.project(20);
  const rent = p.rows.find(r => r.name === "Rent"), pay = p.rows.find(r => r.kind === "pay");
  assert.strictEqual(rent.after, 400);
  assert.strictEqual(pay.after, 900);
  assert.strictEqual(p.low.bal, 400);
});

test("daily spending is the monthly budget spread over 365/12 days", () => {
  R.set({ asOf: "2026-11-01", checking: 1000, floor: 0, pay: { amount: 0, next: "2026-11-01", everyDays: 14, oneOffs: [] },
    bills: [], budget: [{ id: "g", name: "Groceries", monthly: 365 }], debts: [], paid: {}, log: [] });
  const p = R.project(10);
  assert.ok(Math.abs(p.daily - 12) < 1e-9);
  assert.ok(Math.abs(p.end - 880) < 1e-9);
});

test("a bill checked off as paid drops out of that month", () => {
  R.set({ asOf: "2026-11-01", checking: 1000, floor: 0, pay: { amount: 0, next: "2026-11-01", everyDays: 14, oneOffs: [] },
    bills: [{ id: "a", name: "Rent", day: 10, amount: 600 }], budget: [], debts: [], paid: { "2026-11": ["a"] }, log: [] });
  assert.ok(!R.project(20).rows.some(r => r.name === "Rent"));
});

test("bills on the 31st land on the last day of short months", () => {
  R.set({ asOf: "2027-02-01", checking: 1000, floor: 0, pay: { amount: 0, next: "2027-02-01", everyDays: 14, oneOffs: [] },
    bills: [{ id: "a", name: "Card", day: 31, amount: 100 }], budget: [], debts: [], paid: {}, log: [] });
  const r = R.project(27).rows.find(x => x.name === "Card");
  assert.strictEqual(r.date.getDate(), 28);
});

// ---------- bill frequency ----------
test("dueIn handles monthly, quarterly, semiannual, yearly and one-time", () => {
  assert.ok(R.dueIn({}, "2026-11"));
  const q = { freq: "quarterly", start: "2026-11" };
  assert.ok(R.dueIn(q, "2026-11") && R.dueIn(q, "2027-02") && !R.dueIn(q, "2026-12") && !R.dueIn(q, "2026-08"));
  const h = { freq: "semiannual", start: "2026-03" };
  assert.ok(R.dueIn(h, "2026-09") && R.dueIn(h, "2027-03") && !R.dueIn(h, "2026-06"));
  const y = { freq: "yearly", start: "2026-12" };
  assert.ok(R.dueIn(y, "2027-12") && !R.dueIn(y, "2027-11"));
  const o = { freq: "once", start: "2027-01" };
  assert.ok(R.dueIn(o, "2027-01") && !R.dueIn(o, "2028-01"));
  assert.ok(!R.dueIn({ freq: "yearly" }, "2026-11"), "non-monthly bill without a start month never fires");
});

// ---------- debt simulation ----------
const debtState = (debts, extra = 0, method = "avalanche") => ({ asOf: "2026-11-01", checking: 0, floor: 0, extra, method,
  pay: { amount: 0, next: "2026-11-01", everyDays: 14, oneOffs: [] }, bills: [], budget: [], debts, paid: {}, log: [] });

test("a 0% balance with fixed payments pays off on schedule", () => {
  R.set(debtState([{ id: "a", name: "A", balance: 1000, apr: 0, payment: 100 }]));
  const r = R.simulate(0, "avalanche");
  assert.strictEqual(r.months, 10);
  assert.strictEqual(r.totalInt, 0);
});

test("interest accrues monthly at APR / 12", () => {
  R.set(debtState([{ id: "a", name: "A", balance: 1200, apr: 12, payment: 1212 }]));
  const r = R.simulate(0, "avalanche");
  assert.strictEqual(r.months, 1);
  assert.ok(Math.abs(r.totalInt - 12) < 1e-9);
});

test("avalanche pays the highest rate first, snowball the smallest balance", () => {
  const debts = [{ id: "hi", name: "High", balance: 3000, apr: 25, payment: 50 }, { id: "small", name: "Small", balance: 500, apr: 5, payment: 25 }];
  R.set(debtState(debts));
  const av = R.simulate(200, "avalanche"), sn = R.simulate(200, "snowball");
  const done = (r, id) => r.debts.find(d => d.id === id).paidOff;
  assert.ok(done(av, "hi") < done(av, "small") || done(sn, "small") < done(sn, "hi"));
  assert.ok(done(sn, "small") < done(av, "small"), "snowball clears the small balance sooner");
  assert.ok(av.totalInt < sn.totalInt, "avalanche pays less interest");
});

test("an extra payment shortens payoff and cuts interest", () => {
  R.set(debtState([{ id: "a", name: "A", balance: 5000, apr: 20, payment: 150 }]));
  const base = R.simulate(0, "avalanche"), extra = R.simulate(100, "avalanche");
  assert.ok(extra.months < base.months && extra.totalInt < base.totalInt);
});

test("a promo rate switches to the after-promo APR after its end month", () => {
  R.set(debtState([{ id: "a", name: "A", balance: 1000, apr: 0, payment: 50, promoUntil: "2027-01", aprAfter: 24 }]));
  const r = R.simulate(0, "avalanche");
  assert.ok(r.totalInt > 0, "interest starts after the promo");
  const d = r.debts[0];
  assert.ok(Math.abs(d.leftAtPromoEnd - 900) < 1e-9, "balance left when the promo ends: payments in Dec and Jan (the first simulated month follows the balance date)");
  R.set(debtState([{ id: "a", name: "A", balance: 1000, apr: 0, payment: 50 }]));
  assert.strictEqual(R.simulate(0, "avalanche").totalInt, 0, "no end date means the promo never ends");
});

// ---------- bank import ----------
const importState = () => ({ asOf: "2026-11-01", checking: 0, floor: 0, pay: { amount: 0, next: "2026-11-01", everyDays: 14, oneOffs: [] },
  bills: [], budget: [{ id: "g", name: "Groceries", monthly: 400 }, { id: "f", name: "Gas", monthly: 150 }, { id: "d", name: "Dining out", monthly: 100 }],
  debts: [], paid: {}, log: [], rules: {} });

test("single amount column with negative purchases", () => {
  R.set(importState());
  const r = R.buildImport("Transaction Date,Description,Amount\n10/28/2026,MARKET BASKET 42,-86.42\n10/25/2026,PAYMENT THANK YOU,500.00\n10/27/2026,SHELL OIL 5744,-48.10\n");
  assert.strictEqual(r.rows.length, 2); assert.strictEqual(r.deposits, 1);
  assert.deepStrictEqual(plain(r.rows.map(x => [x.date, x.amount, x.cat])), [["2026-10-28", 86.42, "Groceries"], ["2026-10-27", 48.10, "Gas"]]);
});

test("banks that list spending as positive amounts", () => {
  R.set(importState());
  const r = R.buildImport("Date,Description,Amount\n2026-10-01,CHIPOTLE 12,13.40\n2026-10-02,SHELL 9,40.00\n2026-10-03,REFUND,-5.00\n");
  assert.deepStrictEqual(plain(r.rows.map(x => x.amount)), [13.40, 40.00]);
  assert.strictEqual(r.rows[0].cat, "Dining out");
});

test("separate debit and credit columns, parentheses and quoted commas", () => {
  R.set(importState());
  const r = R.buildImport('Date,Description,Debit,Credit\n10/20/26,"STOP & SHOP, WORCESTER",64.18,\n10/21/26,PAYROLL,,1850.00\n10/22/26,MISC,(12.00),\n');
  assert.strictEqual(r.rows.length, 2); assert.strictEqual(r.deposits, 1);
  assert.strictEqual(r.rows[0].note, "STOP & SHOP, WORCESTER");
  assert.strictEqual(r.rows[0].date, "2026-10-20");
  assert.strictEqual(r.rows[1].amount, 12);
});

test("rows already in the log are skipped", () => {
  const st = importState(); st.log = [{ id: "x", date: "2026-10-28", cat: "Groceries", amount: 86.42, note: "MARKET BASKET 42" }];
  R.set(st);
  const r = R.buildImport("Date,Description,Amount\n10/28/2026,MARKET BASKET 42,-86.42\n");
  assert.strictEqual(r.rows.length, 0); assert.strictEqual(r.dupes, 1);
});

test("a file without the needed columns is rejected with a message", () => {
  R.set(importState());
  assert.ok(R.buildImport("Foo,Bar\n1,2\n").error);
});

test("learned merchant categories override the keyword guess", () => {
  const st = importState(); st.rules = { [R.merchantKey("WALMART SUPERCENTER 1882")]: "Dining out" };
  R.set(st);
  assert.strictEqual(R.categorize("WALMART SUPERCENTER 2231"), "Dining out");
  assert.strictEqual(R.merchantKey("Market Basket #17"), R.merchantKey("MARKET BASKET 42"));
});

// ---------- sample data ----------
test("sample data boots into a usable plan", () => {
  R.set(R.sampleState());
  const p = R.project(62), d = R.simulate(R.get().extra, R.get().method);
  assert.ok(p.rows.length > 5 && isFinite(p.low.bal));
  assert.ok(d.months > 0 && d.months < 600);
  assert.ok(R.get().sample === true);
});

// ---------- cash forecast includes debt commitments ----------
const cashDebtState = (debt, bills = []) => ({ asOf: "2026-11-01", checking: 1000, floor: 0,
  pay: { amount: 0, next: "2026-11-01", everyDays: 14, oneOffs: [] },
  bills, budget: [], debts: [{ id: "card", name: "Card", balance: 1000, apr: 0, payment: 100, ...debt }], paid: {}, log: [] });

test("separately scheduled debt reduces the cash forecast", () => {
  R.set(cashDebtState({dueDay: 15}));
  const p = R.project(30);
  assert.strictEqual(p.end, 900);
  assert.strictEqual(p.unscheduledDebts.length, 0);
  assert.ok(p.rows.some(r=>r.name === "Card payment" && r.amt === -100));
});
test("linking an existing bill counts the payment once", () => {
  R.set(cashDebtState({billId: "bill"}, [{id:"bill",name:"Card bill",day:15,amount:100}]));
  assert.strictEqual(R.project(30).end, 900);
  assert.strictEqual(R.project(30).rows.length, 1);
});
test("linked payment reserves at least the debt minimum", () => {
  R.set(cashDebtState({billId:"bill"}, [{id:"bill",name:"Card bill",day:15,amount:50}]));
  assert.strictEqual(R.project(30).end, 900);
});
test("several debts sharing one bill reserve the sum of minimums once", () => {
  const state = cashDebtState({billId:"bill"}, [{id:"bill",name:"Combined",day:15,amount:100}]);
  state.debts.push({id:"other",name:"Other",balance:500,payment:40,billId:"bill"});
  R.set(state);
  assert.strictEqual(R.project(30).end, 860);
  assert.strictEqual(R.project(30).rows.length, 1);
});
test("paid debt payment drops out of that month's projection", () => {
  const state = cashDebtState({dueDay:15}); state.paid = {"2026-11":["debt:card"]};
  R.set(state);
  assert.strictEqual(R.project(30).end, 1000);
});
test("debt due on day 31 clamps to February month-end", () => {
  const state = cashDebtState({dueDay:31}); state.asOf = "2027-02-01";
  R.set(state);
  assert.strictEqual(R.project(27).rows[0].date.getDate(), 28);
});
test("legacy debts with no date withhold the available-cash estimate", () => {
  R.set(cashDebtState({}));
  assert.strictEqual(R.project(30).unscheduledDebts.length, 1);
  assert.ok(R.vPlan().includes("Forecast incomplete"));
  assert.ok(R.vPlan().includes("debt payments still need scheduling"));
});
test("missing linked bill cannot silently fall back to a different date", () => {
  R.set(cashDebtState({billId:"deleted",dueDay:15}));
  assert.strictEqual(R.project(30).unscheduledDebts.length, 1);
  assert.strictEqual(R.project(30).rows.length, 0);
});
test("invalid date or zero payment leaves active debts unresolved", () => {
  for (const debt of [{dueDay:0},{dueDay:32},{dueDay:1.5},{dueDay:15,payment:0}]){
    R.set(cashDebtState(debt));
    assert.strictEqual(R.project(30).unscheduledDebts.length, 1);
  }
});
test("paid-off debts no longer create separate cash events", () => {
  R.set(cashDebtState({balance:0,dueDay:15}));
  assert.strictEqual(R.project(30).rows.length, 0);
  assert.strictEqual(R.project(30).unscheduledDebts.length, 0);
});

// ---------- backup validation and storage recovery ----------
const backupState = () => ({asOf:"2026-11-01",checking:1000,floor:100,
  pay:{amount:500,next:"2026-11-15",everyDays:14,oneOffs:[]},
  bills:[{id:"rent",name:"Rent",day:10,amount:600}],budget:[],debts:[],paid:{},log:[]});
test("legacy backups are validated without changing the caller", () => {
  const source=backupState(); source.checking="123.45";
  const candidate=R.validateBackup(source);
  assert.strictEqual(candidate.schemaVersion,1);
  assert.strictEqual(candidate.checking,123.45);
  assert.strictEqual(source.checking,"123.45");
  assert.ok(!("schemaVersion" in source));
});
test("invalid nested records and versions leave the current plan unchanged", () => {
  R.set(backupState()); const before=JSON.stringify(R.get());
  const invalid=[null,[],{bills:[]},
    {...backupState(),pay:[]},{...backupState(),pay:null},
    {...backupState(),debts:{}},{...backupState(),log:null},
    {...backupState(),paid:{"2026-11":{}}},{...backupState(),rules:{shop:5}},
    {...backupState(),schemaVersion:2},
    {...backupState(),bills:[{id:"a",day:32,amount:100}]},
    {...backupState(),bills:[{id:"a",amount:1},{id:"a",amount:2}]},
    {...backupState(),asOf:"2026-02-31"},
    {...backupState(),checking:Infinity}];
  for (const candidate of invalid){
    assert.throws(()=>R.restoreBackup(JSON.stringify(candidate)));
    assert.strictEqual(JSON.stringify(R.get()),before);
  }
  assert.throws(()=>R.validateBackup({...backupState(),checking:Infinity}));
  const overflow=JSON.stringify({...backupState(),debts:[{id:"a",balance:10,aprAfter:0}]}).replace('"aprAfter":0','"aprAfter":1e999');
  assert.throws(()=>R.restoreBackup(overflow));
});
test("restoring saves immediately and retains the previous bytes", () => {
  R.set(backupState()); const previous=JSON.stringify(R.get()); store["runway.v1"]=previous;
  const next={...backupState(),checking:700};
  R.restoreBackup(JSON.stringify(next));
  assert.strictEqual(R.get().checking,700);
  assert.strictEqual(JSON.parse(store["runway.v1"]).checking,700);
  assert.strictEqual(store["runway.v1.previous"],previous);
});
test("quota failure leaves the current plan and stored document intact", () => {
  R.set(backupState()); store["runway.v1"]=JSON.stringify(R.get());
  const before=store["runway.v1"], setter=sandbox.localStorage.setItem;
  sandbox.localStorage.setItem=(key,value)=>{if(key==="runway.v1") throw new Error("quota"); setter(key,value);};
  try { assert.throws(()=>R.restoreBackup(JSON.stringify({...backupState(),checking:4})),/Could not save/); }
  finally {sandbox.localStorage.setItem=setter;}
  assert.strictEqual(JSON.stringify(R.get()),before);
  assert.strictEqual(store["runway.v1"],before);
});
test("failed previous-save backup prevents replacement of the primary document", () => {
  const before=store["runway.v1"], setter=sandbox.localStorage.setItem;
  sandbox.localStorage.setItem=(key,value)=>{if(key.endsWith(".previous")) throw new Error("quota"); setter(key,value);};
  try {assert.throws(()=>R.restoreBackup(JSON.stringify({...backupState(),checking:4})));}
  finally {sandbox.localStorage.setItem=setter;}
  assert.strictEqual(store["runway.v1"],before);
});
test("damaged stored JSON is preserved until an explicit valid restore", () => {
  store["runway.v1"]="{broken";
  assert.strictEqual(R.load(),null);
  R.set(backupState()); assert.strictEqual(R.flush(),false);
  assert.strictEqual(store["runway.v1"],"{broken");
  R.restoreBackup(JSON.stringify(backupState()));
  assert.strictEqual(store["runway.v1.previous"],"{broken");
  assert.strictEqual(JSON.parse(store["runway.v1"]).checking,1000);
});
test("invalid JSON does not touch either storage or the current plan", () => {
  const before=JSON.stringify(R.get()), persisted=store["runway.v1"];
  assert.throws(()=>R.restoreBackup("{broken"),/not valid JSON/);
  assert.strictEqual(JSON.stringify(R.get()),before);
  assert.strictEqual(store["runway.v1"],persisted);
});

test("explicit erase also clears the previous-save copy", () => {
  R.erasePlan();
  assert.strictEqual(store["runway.v1.previous"],undefined);
  assert.strictEqual(JSON.parse(store["runway.v1"]).bills.length,0);
  assert.strictEqual(R.get().checking,0);
});
test("failed erase reports failure and does not replace the in-memory plan", () => {
  R.set(backupState()); const before=JSON.stringify(R.get());
  const remove=sandbox.localStorage.removeItem;
  sandbox.localStorage.removeItem=()=>{throw new Error("blocked");};
  try {assert.throws(()=>R.erasePlan(),/Could not erase/);}
  finally {sandbox.localStorage.removeItem=remove;}
  assert.strictEqual(JSON.stringify(R.get()),before);
});
test("an unreadable initial document cannot be overwritten when storage becomes available", () => {
  store["runway.v1"]=JSON.stringify(R.normalize(backupState()));
  const previous=store["runway.v1"], get=sandbox.localStorage.getItem;
  sandbox.localStorage.getItem=()=>{throw new Error("read blocked");};
  try {assert.strictEqual(R.load(),null);} finally {sandbox.localStorage.getItem=get;}
  R.set({...backupState(),checking:25});
  assert.strictEqual(R.flush(),false);
  assert.strictEqual(store["runway.v1"],previous);
  R.restoreBackup(JSON.stringify(backupState()));
  assert.strictEqual(R.flush(),true);
});
test("legacy signed values used for credits and overdraft floors are preserved", () => {
  const source=backupState(); source.floor=-100; source.bills[0].amount=-25;
  source.debts=[{id:"credit",name:"Card credit",balance:-50,apr:0,payment:0}];
  const candidate=R.validateBackup(source);
  assert.strictEqual(candidate.floor,-100);
  assert.strictEqual(candidate.bills[0].amount,-25);
  assert.strictEqual(candidate.debts[0].balance,-50);
});
console.log(`all ${passed} Runway tests passed`);
