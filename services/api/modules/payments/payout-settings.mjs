import {envInt} from '../../shared/env-values.mjs';
/** The only place withdrawal settings are read, so the wallet and withdrawals always agree. */
export const payoutSettings=(env=process.env)=>({
 minMinor:envInt(env.WITHDRAWAL_MIN_MINOR,10000),
 feeMinor:envInt(env.WITHDRAWAL_FEE_MINOR,100,0),
 platformDailyLimitMinor:envInt(env.WITHDRAWAL_PLATFORM_DAILY_LIMIT_MINOR,0,0),
 earningsHoldHours:envInt(env.WITHDRAWAL_EARNINGS_HOLD_HOURS,24,0),
 securityHoldHours:envInt(env.WITHDRAWAL_SECURITY_HOLD_HOURS,24,0)
});
