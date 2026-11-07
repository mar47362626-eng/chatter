const assert = require("node:assert/strict");
const { APP_DATA_PLAN_OPTIONS, getPlanById, getPlanUsageSummary } = require("./data-billing");

assert.ok(Array.isArray(APP_DATA_PLAN_OPTIONS) && APP_DATA_PLAN_OPTIONS.length > 0, "plans should be defined");
assert.equal(getPlanById("free-500mb").name, "Free 500 MB");

const summary = getPlanUsageSummary({
  planId: "bundle-5gb",
  usedBytes: 7 * 1024 * 1024 * 1024
});
assert.equal(summary.planId, "bundle-5gb");
assert.equal(summary.limitBytes, 5 * 1024 * 1024 * 1024);
assert.equal(summary.overageBytes, 2 * 1024 * 1024 * 1024);
assert.equal(summary.extraCharge, 400);
assert.equal(summary.remainingBytes, 0);

console.log("data billing checks passed");
