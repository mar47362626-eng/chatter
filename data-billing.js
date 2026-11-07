const ONE_GIGABYTE = 1024 * 1024 * 1024;

const APP_DATA_PLAN_OPTIONS = [
  {
    id: "free-500mb",
    name: "Free 500 MB",
    amount: 0,
    currency: "NGN",
    dataLimitBytes: 500 * 1024 * 1024,
    overagePricePerGb: 200,
    description: "Starter allowance for casual chats",
    isDefault: true
  },
  {
    id: "bundle-2gb",
    name: "2 GB",
    amount: 1500,
    currency: "NGN",
    dataLimitBytes: 2 * ONE_GIGABYTE,
    overagePricePerGb: 200,
    description: "Good for light daily use",
    isDefault: false
  },
  {
    id: "bundle-5gb",
    name: "5 GB",
    amount: 3000,
    currency: "NGN",
    dataLimitBytes: 5 * ONE_GIGABYTE,
    overagePricePerGb: 200,
    description: "Balanced plan for regular users",
    isDefault: false
  },
  {
    id: "bundle-10gb",
    name: "10 GB",
    amount: 5500,
    currency: "NGN",
    dataLimitBytes: 10 * ONE_GIGABYTE,
    overagePricePerGb: 200,
    description: "Best for busy messaging and media",
    isDefault: false
  }
];

function getPlanById(planId) {
  return APP_DATA_PLAN_OPTIONS.find((plan) => plan.id === planId) || APP_DATA_PLAN_OPTIONS[0];
}

function getPlanUsageSummary({ planId, usedBytes }) {
  const plan = getPlanById(planId);
  const safeUsedBytes = Number.isFinite(Number(usedBytes)) ? Math.max(0, Number(usedBytes)) : 0;
  const limitBytes = Number(plan.dataLimitBytes);
  const overageBytes = Math.max(0, safeUsedBytes - limitBytes);
  const remainingBytes = Math.max(0, limitBytes - safeUsedBytes);
  const extraGigabytes = overageBytes > 0 ? Math.ceil(overageBytes / ONE_GIGABYTE) : 0;
  const extraCharge = extraGigabytes * plan.overagePricePerGb;

  return {
    planId: plan.id,
    planName: plan.name,
    amount: plan.amount,
    currency: plan.currency,
    limitBytes,
    usedBytes: safeUsedBytes,
    remainingBytes,
    overageBytes,
    extraCharge,
    status: overageBytes > 0 ? "over_limit" : "within_limit"
  };
}

module.exports = {
  APP_DATA_PLAN_OPTIONS,
  getPlanById,
  getPlanUsageSummary
};
