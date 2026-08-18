// Centralized financial constants -- referenced by lib/wallet.js, lib/
// referral.js, and the deposit-approval routes so a value like "the
// high-tier deposit threshold" only ever needs to change in one place.
module.exports = {
  // The deposit amount (in tokens/rupees, 1:1 in this app) at and above
  // which a referred user's deposit earns the referrer the HIGH tier
  // reward instead of the LOW tier. Exactly this amount counts as the
  // high tier ("500 or above").
  REFERRAL_QUALIFYING_DEPOSIT: 500,
  // Reward paid to the referrer for a referred user's deposit that is
  // *below* REFERRAL_QUALIFYING_DEPOSIT.
  REFERRAL_LOW_TIER_REWARD: 50,
  // Reward paid to the referrer for a referred user's deposit that is
  // *at or above* REFERRAL_QUALIFYING_DEPOSIT. Paid on every qualifying
  // deposit the referred user makes (not just their first).
  REFERRAL_SIGNUP_REWARD: 500,
};
