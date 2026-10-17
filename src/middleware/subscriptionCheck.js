/** This release is free. Legacy subscription columns remain for upgrade compatibility.
 * Billing requires a separately reviewed future release; no remote switch enables it here.
 */
export const checkSubscriptionStatus = (_req, _res, next) => next();
export const requireActiveSubscription = checkSubscriptionStatus;
export const softSubscriptionCheck = checkSubscriptionStatus;
