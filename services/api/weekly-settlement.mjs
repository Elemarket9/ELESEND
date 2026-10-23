import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check} from './security.mjs';

const weeklySettlementSettingsSchema = z.object({
  cutoffDayOfWeek: z.number().int().min(1).max(7).optional(),
  cutoffTimeUtc: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/, 'Invalid UTC time format (expected HH:MM:SS)').optional(),
  graceHours: z.number().int().min(0).max(168).optional(),
  defaultCommissionBps: z.number().int().min(0).max(5000).optional(),
  remindersEnabled: z.boolean().optional()
}).strict().refine(v => Object.keys(v).length > 0, { message: 'At least one setting field must be provided' });

/**
 * Returns the ISO 8601 calendar week key (e.g. '2026-W43') for any given Date in GMT (Africa/Accra UTC+0).
 */
export function getGhanaWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7; // 1 = Monday, 7 = Sunday
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return date.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
}

/**
 * Returns exact weekly cycle boundaries in Africa/Accra (UTC+0):
 * - start: Monday 00:00:00.000 UTC
 * - end: Sunday 23:59:59.999 UTC
 * - cutoff: Next Monday 00:00:00.000 UTC (+ grace hours and configurable cutoff time)
 */
export function getGhanaWeekRange(d = new Date(), {graceHours = 0, cutoffDayOfWeek = 1, cutoffTimeUtc = '00:00:00'} = {}) {
  const date = new Date(d);
  const day = date.getUTCDay() || 7;
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 1, 0, 0, 0, 0));
  const end = new Date(start.getTime() + (7 * 86400000) - 1);
  const baseCutoff = new Date(start.getTime() + (7 * 86400000));
  
  const [cH, cM, cS] = String(cutoffTimeUtc || '00:00:00').split(':').map(Number);
  const cutoffTimeOffsetMs = ((cH || 0) * 3600 + (cM || 0) * 60 + (cS || 0)) * 1000;
  const dayOffsetDays = (cutoffDayOfWeek - 1);
  const cutoff = new Date(baseCutoff.getTime() + (dayOffsetDays * 86400000) + cutoffTimeOffsetMs + (graceHours * 3600000));
  
  const weekKey = getGhanaWeekKey(start);
  const nowMs = date.getTime();
  return {
    weekKey,
    start,
    end,
    baseCutoff,
    cutoff,
    isCurrentWeek: nowMs >= start.getTime() && nowMs <= end.getTime(),
    isPastCutoff: nowMs >= cutoff.getTime()
  };
}

/**
 * Formats a deterministic human-auditable settlement receipt number:
 * REC-YYYYMMDD-XXXXXXXX
 */
export function generateReceiptNumber(intentId, date = new Date()) {
  const d = new Date(date);
  const yyyymmdd = d.getUTCFullYear() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0');
  const cleanId = String(intentId).replaceAll('-', '').slice(0, 8).toUpperCase();
  return `REC-${yyyymmdd}-${cleanId}`;
}

/**
 * Canonical Ghana Mobile Money networks
 */
export const SUPPORTED_MOMO_NETWORKS = ['MTN', 'TELECEL', 'AT'];

export function normalizeMomoNetwork(net) {
  if (!net || typeof net !== 'string') return null;
  const upper = net.trim().toUpperCase();
  if (upper === 'MTN' || upper.includes('MTN')) return 'MTN';
  if (upper === 'TELECEL' || upper.includes('VODAFONE') || upper.includes('VODA')) return 'TELECEL';
  if (upper === 'AT' || upper.includes('AIRTEL') || upper.includes('TIGO')) return 'AT';
  return null;
}

/**
 * Validates Ghanaian MSISDN format
 */
export function normalizeGhanaPhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const cleaned = phone.replace(/[^0-9+]/g, '');
  if (/^0[235][0-9]{8}$/.test(cleaned)) return cleaned;
  if (/^\+233[235][0-9]{8}$/.test(cleaned)) return '0' + cleaned.slice(4);
  if (/^233[235][0-9]{8}$/.test(cleaned)) return '0' + cleaned.slice(3);
  return null;
}

/**
 * Retrieves weekly settlement settings from database
 */
export async function getWeeklySettlementSettings(c) {
  const res = await c.query('SELECT * FROM weekly_settlement_settings WHERE id=$1', ['default']);
  if (res.rowCount > 0) return res.rows[0];
  return {
    cutoff_day_of_week: 1,
    cutoff_time_utc: '00:00:00',
    grace_hours: 0,
    default_commission_bps: 1300,
    reminders_enabled: true
  };
}

/**
 * Evaluates rider obligations and breaks down into:
 * - currentWeekAccruedMinor: active current week debt (not overdue before cutoff)
 * - overdueMinor: debt from past closed weeks (past Monday 00:00 cutoff)
 * - totalPayableMinor: sum of all unpaid obligations
 */
export async function getRiderWeeklyBalance(c, riderId, {now = new Date()} = {}) {
  const settings = await getWeeklySettlementSettings(c);
  const currentWeek = getGhanaWeekRange(now, {
    graceHours: settings.grace_hours,
    cutoffDayOfWeek: settings.cutoff_day_of_week,
    cutoffTimeUtc: settings.cutoff_time_utc
  });

  // Prior week cutoff: when did the immediate previous week expire?
  // Previous week started 7 days before currentWeek.start
  const priorWeekStart = new Date(currentWeek.start.getTime() - (7 * 86400000));
  const priorWeek = getGhanaWeekRange(priorWeekStart, {
    graceHours: settings.grace_hours,
    cutoffDayOfWeek: settings.cutoff_day_of_week,
    cutoffTimeUtc: settings.cutoff_time_utc
  });

  // Fetch all obligations and their current allocated amounts
  const rows = (await c.query(`
    SELECT o.id, o.shipment_id, o.original_minor, o.due_at, o.created_at, o.week_key,
      coalesce(sum(a.amount_minor), 0)::bigint AS allocated_minor
    FROM commission_obligations o
    LEFT JOIN commission_allocations a ON a.obligation_id = o.id
    WHERE o.rider_id = $1
    GROUP BY o.id
    ORDER BY o.created_at ASC, o.id ASC
  `, [riderId])).rows;

  let currentWeekAccruedMinor = 0;
  let currentWeekJobs = 0;
  let currentWeekObligations = 0;
  let overdueMinor = 0;
  let overdueCount = 0;
  let overdueJobs = 0;
  let oldestOverdueAt = null;

  for (const r of rows) {
    const original = Number(r.original_minor);
    const allocated = Number(r.allocated_minor);
    const remaining = original - allocated;
    if (remaining <= 0) continue; // Settled in full

    const createdAt = new Date(r.created_at);
    const dueAt = new Date(r.due_at);
    const weekKey = r.week_key || getGhanaWeekKey(createdAt);
    const isCurrent = weekKey === currentWeek.weekKey && dueAt.getTime() >= currentWeek.start.getTime();

    if (isCurrent) {
      // If the current week is already past its cutoff, it has become overdue
      if (currentWeek.isPastCutoff) {
        overdueMinor += remaining;
        overdueCount++;
        if (r.shipment_id) overdueJobs++;
        if (!oldestOverdueAt || createdAt < oldestOverdueAt) oldestOverdueAt = createdAt;
      } else {
        currentWeekAccruedMinor += remaining;
        currentWeekObligations++;
        if (r.shipment_id) currentWeekJobs++;
      }
    } else {
      // Obligation from a prior week. Check if its cutoff has passed
      // If from immediately prior week and still within grace period:
      const isImmediatelyPrior = weekKey === priorWeek.weekKey && dueAt.getTime() >= priorWeek.start.getTime();
      if (isImmediatelyPrior && now.getTime() < priorWeek.cutoff.getTime()) {
        currentWeekAccruedMinor += remaining;
        currentWeekObligations++;
        if (r.shipment_id) currentWeekJobs++;
      } else {
        overdueMinor += remaining;
        overdueCount++;
        if (r.shipment_id) overdueJobs++;
        if (!oldestOverdueAt || createdAt < oldestOverdueAt) {
          oldestOverdueAt = createdAt;
        }
      }
    }
  }

  const riderRow = (await c.query('SELECT status, financial_restriction FROM riders WHERE id=$1', [riderId])).rows[0];
  const isRestricted = overdueMinor > 0 || riderRow?.financial_restriction === 'OVERDUE_CASH_COMMISSION';

  return {
    riderId,
    currentWeekKey: currentWeek.weekKey,
    currentWeekAccruedMinor,
    currentWeekJobs,
    currentWeekObligations,
    overdueMinor,
    overdueCount,
    overdueJobs,
    totalPayableMinor: currentWeekAccruedMinor + overdueMinor,
    oldestOverdueAt,
    isRestricted,
    financialRestriction: riderRow?.financial_restriction || null,
    accountStatus: riderRow?.status || 'approved',
    currentWeekCutoff: currentWeek.cutoff
  };
}

/**
 * Fast, authoritative check of rider weekly dispatch eligibility.
 * Restricts if rider owes ANY overdue debt from closed weeks,
 * or if rider has financial_restriction = 'OVERDUE_CASH_COMMISSION'.
 */
export async function evaluateRiderWeeklyEligibility(c, riderId, {now = new Date()} = {}) {
  const rider = (await c.query('SELECT status, financial_restriction FROM riders WHERE id=$1', [riderId])).rows[0];
  if (!rider) return {eligible: false, reason: 'RIDER_NOT_FOUND', overdueMinor: 0};

  // If rider is explicitly marked restricted for overdue cash commission:
  if (rider.financial_restriction === 'OVERDUE_CASH_COMMISSION') {
    const bal = await getRiderWeeklyBalance(c, riderId, {now});
    return {
      eligible: false,
      reason: 'OVERDUE_CASH_COMMISSION',
      overdueMinor: bal.overdueMinor,
      totalPayableMinor: bal.totalPayableMinor
    };
  }

  // Runtime check: even if background cron has not run, check if rider has overdue closed-week debt past cutoff
  const bal = await getRiderWeeklyBalance(c, riderId, {now});
  if (bal.overdueMinor > 0) {
    return {
      eligible: false,
      reason: 'OVERDUE_CASH_COMMISSION',
      overdueMinor: bal.overdueMinor,
      totalPayableMinor: bal.totalPayableMinor
    };
  }

  return {
    eligible: true,
    overdueMinor: 0,
    totalPayableMinor: bal.totalPayableMinor
  };
}

/**
 * Batch reconciliation and enforcement of weekly restrictions.
 * - Restricts riders with overdue debt past cutoff.
 * - Automatically restores riders who have fully settled overdue debt.
 * - PRESERVES unrelated suspensions (riders.status = 'suspended').
 */
export async function reconcileAndEnforceWeeklyRestrictions(db, {now = new Date()} = {}) {
  return db.tx(async c => {
    const riders = (await c.query("SELECT id, status, financial_restriction FROM riders WHERE status IN ('approved', 'suspended')")).rows;
    let restrictedCount = 0;
    let restoredCount = 0;

    for (const rider of riders) {
      const bal = await getRiderWeeklyBalance(c, rider.id, {now});

      // 1. Should be restricted: has overdue closed-week commission and not currently flagged
      if (bal.overdueMinor > 0 && rider.financial_restriction !== 'OVERDUE_CASH_COMMISSION') {
        await c.query(`
          UPDATE riders
          SET financial_restriction = 'OVERDUE_CASH_COMMISSION', financial_restriction_at = now()
          WHERE id = $1
        `, [rider.id]);
        await c.query(`
          INSERT INTO audit_logs(actor_id, action, entity_id)
          VALUES($1, 'rider.restricted_cash_commission', $1)
        `, [rider.id]);
        restrictedCount++;

        // Send overdue notification
        await recordSettlementNotification(c, {
          riderId: rider.id,
          type: 'MONDAY_OVERDUE',
          weekKey: bal.currentWeekKey,
          recipient: rider.id,
          message: `ELESEND Notice: Your dispatch is restricted due to overdue cash commission of GH₵${(bal.overdueMinor/100).toFixed(2)}. Settle now via MoMo to restore dispatch.`
        });
      }

      // 2. Should be restored: was flagged OVERDUE_CASH_COMMISSION but overdue debt is now 0
      if (bal.overdueMinor === 0 && rider.financial_restriction === 'OVERDUE_CASH_COMMISSION') {
        // Clear ONLY the financial restriction. NEVER change riders.status (preserves safety/fraud suspensions)
        await c.query(`
          UPDATE riders
          SET financial_restriction = NULL, financial_restriction_at = NULL
          WHERE id = $1
        `, [rider.id]);
        await c.query(`
          INSERT INTO audit_logs(actor_id, action, entity_id)
          VALUES($1, 'rider.restriction_cleared_cash_commission', $1)
        `, [rider.id]);
        restoredCount++;

        // Send restoration notification
        await recordSettlementNotification(c, {
          riderId: rider.id,
          type: 'RESTORATION_NOTICE',
          weekKey: bal.currentWeekKey,
          recipient: rider.id,
          message: `ELESEND Confirmation: Your overdue cash commission is fully settled. Your dispatch eligibility has been restored.`
        });
      }
    }

    return {restrictedCount, restoredCount, timestamp: now.toISOString()};
  });
}

/**
 * Detailed summary for Rider Mobile UI and API endpoints
 */
export async function getRiderWeeklySummary(db, riderId, {now = new Date()} = {}) {
  return db.tx(async c => {
    const settings = await getWeeklySettlementSettings(c);
    const weekRange = getGhanaWeekRange(now, {
      graceHours: settings.grace_hours,
      cutoffDayOfWeek: settings.cutoff_day_of_week,
      cutoffTimeUtc: settings.cutoff_time_utc
    });
    const bal = await getRiderWeeklyBalance(c, riderId, {now});

    // Recent deliveries breakdown (last 50 cash shipments)
    const entries = (await c.query(`
      SELECT o.id AS obligation_id, o.shipment_id, o.original_minor AS commission_minor,
             o.due_at, o.created_at, o.week_key,
             s.amount_minor AS delivery_fee_minor,
             s.state AS shipment_state,
             coalesce(cc.reported_minor, s.amount_minor) AS cash_collected_minor,
             coalesce(sum(a.amount_minor), 0)::bigint AS allocated_minor
      FROM commission_obligations o
      LEFT JOIN shipments s ON s.id = o.shipment_id
      LEFT JOIN cash_collections cc ON cc.shipment_id = o.shipment_id
      LEFT JOIN commission_allocations a ON a.obligation_id = o.id
      WHERE o.rider_id = $1
      GROUP BY o.id, s.id, cc.reported_minor
      ORDER BY o.created_at DESC
      LIMIT 50
    `, [riderId])).rows.map(row => {
      const remaining = Math.max(0, Number(row.commission_minor) - Number(row.allocated_minor));
      const isSettled = remaining <= 0;
      const effectiveWeekKey = row.week_key || getGhanaWeekKey(new Date(row.created_at));
      const isCurrent = effectiveWeekKey === weekRange.weekKey;
      return {
        obligationId: row.obligation_id,
        shipmentId: row.shipment_id,
        deliveryFeeMinor: Number(row.delivery_fee_minor || 0),
        cashCollectedMinor: Number(row.cash_collected_minor || 0),
        commissionMinor: Number(row.commission_minor),
        allocatedMinor: Number(row.allocated_minor),
        remainingMinor: remaining,
        weekKey: effectiveWeekKey,
        createdAt: row.created_at,
        dueAt: row.due_at,
        status: isSettled ? 'settled' : isCurrent ? 'current' : 'overdue'
      };
    });

    // Payment history (confirmed MoMo settlements)
    const payments = (await c.query(`
      SELECT si.id, si.provider, si.amount_minor, si.momo_network, si.momo_phone,
             si.receipt_number, si.confirmed_at, si.created_at,
             (SELECT spe.event_id FROM settlement_provider_events spe WHERE spe.intent_id = si.id ORDER BY spe.recorded_at ASC LIMIT 1) AS provider_event_id
      FROM settlement_intents si
      WHERE si.rider_id = $1 AND si.status = 'confirmed'
      ORDER BY si.confirmed_at DESC NULLS LAST, si.created_at DESC
      LIMIT 30
    `, [riderId])).rows.map(p => ({
      intentId: p.id,
      receiptNumber: p.receipt_number || generateReceiptNumber(p.id, p.confirmed_at || p.created_at),
      amountMinor: Number(p.amount_minor),
      momoNetwork: p.momo_network || 'MOMO',
      momoPhone: p.momo_phone || null,
      provider: p.provider,
      providerEventId: p.provider_event_id || null,
      confirmedAt: p.confirmed_at || p.created_at
    }));

    // Calculate countdown
    const msUntilCutoff = Math.max(0, weekRange.cutoff.getTime() - now.getTime());
    const hoursUntilCutoff = Math.floor(msUntilCutoff / 3600000);
    const deadlineDescription = bal.overdueMinor > 0
      ? 'OVERDUE — Immediate settlement required'
      : `Due Monday 00:00 GMT (${hoursUntilCutoff}h remaining)`;

    return {
      riderId,
      status: bal.isRestricted ? 'RESTRICTED' : 'ACTIVE',
      restrictionReason: bal.financialRestriction,
      accountStatus: bal.accountStatus,
      currentWeek: {
        weekKey: weekRange.weekKey,
        start: weekRange.start.toISOString(),
        end: weekRange.end.toISOString(),
        cutoff: weekRange.cutoff.toISOString(),
        accruedMinor: bal.currentWeekAccruedMinor,
        jobCount: bal.currentWeekJobs
      },
      overdue: {
        overdueMinor: bal.overdueMinor,
        overdueCount: bal.overdueCount,
        oldestOverdueAt: bal.oldestOverdueAt ? bal.oldestOverdueAt.toISOString() : null
      },
      totalPayableMinor: bal.totalPayableMinor,
      minimumToClearRestrictionMinor: bal.overdueMinor,
      deadline: {
        cutoff: weekRange.cutoff.toISOString(),
        description: deadlineDescription,
        isOverdue: bal.overdueMinor > 0,
        hoursUntilCutoff
      },
      supportedNetworks: SUPPORTED_MOMO_NETWORKS,
      recentDeliveries: entries,
      paymentHistory: payments
    };
  });
}

/**
 * Record a low-cost automated notification to settlement_notifications
 */
export async function recordSettlementNotification(c, {riderId, type, weekKey, channel = 'sms', recipient, message, metadata = {}}) {
  const id = randomUUID();
  await c.query(`
    INSERT INTO settlement_notifications(id, rider_id, notification_type, week_key, channel, recipient, message, metadata)
    VALUES($1, $2, $3, $4, $5, $6, $7, $8)
  `, [id, riderId, type, weekKey, channel, recipient, message, JSON.stringify(metadata)]);
  return {id, queued: true, sent: false};
}

/**
 * Admin Overview: metrics & filtered rider settlements
 */
export async function getAdminSettlementOverview(db, {actor = null, filter = 'all', now = new Date()} = {}) {
  check(['all', 'overdue', 'restricted', 'settled', 'current'].includes(filter), 400, 'Invalid settlement filter');
  return db.tx(async c => {
    if (actor) {
      check(actor.kind === 'admin', 403, 'Administrator required');
      const hasPermission = (await c.query(
        "SELECT 1 FROM permissions WHERE user_id = $1 AND permission = ANY($2::text[])",
        [actor.id, ['finance:read', 'finance:approve', 'finance:configure']]
      )).rowCount;
      check(hasPermission, 403, 'Finance permission required');
    }
    const riders = (await c.query(`
      SELECT r.id, r.vehicle, r.status AS account_status, r.financial_restriction,
             u.phone
      FROM riders r
      JOIN users u ON u.id = r.id
      WHERE r.status IN ('approved', 'suspended')
      ORDER BY u.created_at ASC
    `)).rows;

    let totalAccruedMinor = 0;
    let totalCollectedMinor = 0;
    let totalOverdueMinor = 0;
    let restrictedRidersCount = 0;

    const list = [];
    for (const r of riders) {
      const bal = await getRiderWeeklyBalance(c, r.id, {now});
      totalAccruedMinor += (bal.currentWeekAccruedMinor + bal.overdueMinor);
      totalOverdueMinor += bal.overdueMinor;
      if (bal.isRestricted) restrictedRidersCount++;

      const isOverdue = bal.overdueMinor > 0;
      const isRestricted = bal.isRestricted;
      const isSettled = bal.totalPayableMinor === 0;

      let matchesFilter = true;
      if (filter === 'overdue' && !isOverdue) matchesFilter = false;
      if (filter === 'restricted' && !isRestricted) matchesFilter = false;
      if (filter === 'settled' && !isSettled) matchesFilter = false;
      if (filter === 'current' && (isOverdue || isSettled)) matchesFilter = false;

      if (matchesFilter) {
        list.push({
          riderId: r.id,
          name: 'Rider ' + (r.phone ? r.phone.slice(-4) : 'User'),
          phone: r.phone,
          vehicle: r.vehicle,
          accountStatus: r.account_status,
          financialRestriction: r.financial_restriction,
          currentWeekAccruedMinor: bal.currentWeekAccruedMinor,
          overdueMinor: bal.overdueMinor,
          totalPayableMinor: bal.totalPayableMinor,
          status: isRestricted ? 'RESTRICTED' : 'ACTIVE'
        });
      }
    }

    // Total collected from all settlement intents
    const collectedRes = await c.query("SELECT coalesce(sum(amount_minor), 0)::bigint AS collected FROM settlement_intents WHERE status='confirmed'");
    totalCollectedMinor = Number(collectedRes.rows[0].collected);

    return {
      metrics: {
        totalAccruedMinor,
        totalCollectedMinor,
        totalOverdueMinor,
        restrictedRidersCount,
        activeRidersCount: riders.filter(r => r.account_status === 'approved').length,
        totalRidersCount: riders.length
      },
      riders: list
    };
  });
}

/**
 * Historical settlement periods for Rider (Phase 5.E)
 */
export async function getRiderWeeklyHistory(db, riderId, {limitWeeks = 12, now = new Date()} = {}) {
  return db.tx(async c => {
    const settings = await getWeeklySettlementSettings(c);
    const currentWeek = getGhanaWeekRange(now, {
      graceHours: settings.grace_hours,
      cutoffDayOfWeek: settings.cutoff_day_of_week,
      cutoffTimeUtc: settings.cutoff_time_utc
    });
    const priorWeekStart = new Date(currentWeek.start.getTime() - (7 * 86400000));
    const priorWeek = getGhanaWeekRange(priorWeekStart, {
      graceHours: settings.grace_hours,
      cutoffDayOfWeek: settings.cutoff_day_of_week,
      cutoffTimeUtc: settings.cutoff_time_utc
    });

    // Aggregate allocations per obligation FIRST so multiple allocations on a single
    // obligation never multiply original_minor or job_count, and separate shipment jobs
    // from non-shipment obligations.
    const rows = (await c.query(`
      WITH per_obligation AS (
        SELECT
          o.id,
          o.shipment_id,
          coalesce(o.week_key, to_char(o.created_at AT TIME ZONE 'UTC', 'IYYY-"W"IW')) AS week_key,
          o.original_minor,
          o.due_at,
          o.created_at,
          coalesce(sum(a.amount_minor), 0)::bigint AS allocated_minor
        FROM commission_obligations o
        LEFT JOIN commission_allocations a ON a.obligation_id = o.id
        WHERE o.rider_id = $1
        GROUP BY o.id
      )
      SELECT
        week_key,
        count(shipment_id)::int AS job_count,
        count(*)::int AS obligation_count,
        coalesce(sum(original_minor), 0)::bigint AS accrued_minor,
        coalesce(sum(allocated_minor), 0)::bigint AS allocated_minor,
        coalesce(sum(GREATEST(0, original_minor - allocated_minor)), 0)::bigint AS outstanding_minor,
        min(created_at) AS earliest_job_at,
        max(created_at) AS latest_job_at,
        min(due_at) AS earliest_due_at
      FROM per_obligation
      GROUP BY week_key
      ORDER BY week_key DESC
      LIMIT $2
    `, [riderId, limitWeeks])).rows;

    return rows.map(r => {
      const accrued = Number(r.accrued_minor);
      const allocated = Number(r.allocated_minor);
      const outstanding = Number(r.outstanding_minor);
      const earliestDue = r.earliest_due_at ? new Date(r.earliest_due_at) : null;
      const isCurrent = r.week_key === currentWeek.weekKey && (!earliestDue || earliestDue.getTime() >= currentWeek.start.getTime());
      const isImmediatelyPriorWithinGrace = r.week_key === priorWeek.weekKey
        && (!earliestDue || earliestDue.getTime() >= priorWeek.start.getTime())
        && now.getTime() < priorWeek.cutoff.getTime();
      let status = 'fully_settled';
      if (outstanding > 0) {
        if ((isCurrent && !currentWeek.isPastCutoff) || isImmediatelyPriorWithinGrace) {
          status = allocated > 0 ? 'partially_settled' : 'current';
        } else {
          status = allocated > 0 ? 'partially_settled_overdue' : 'overdue';
        }
      }
      return {
        weekKey: r.week_key,
        jobCount: r.job_count,
        obligationCount: r.obligation_count,
        accruedMinor: accrued,
        allocatedMinor: allocated,
        outstandingMinor: outstanding,
        status,
        isCurrentWeek: isCurrent,
        earliestJobAt: r.earliest_job_at,
        latestJobAt: r.latest_job_at
      };
    });
  });
}

/**
 * Admin Configuration for Weekly Settlement (Phase 13)
 */
export async function updateWeeklySettlementSettings(db, actor, settings = {}) {
  check(actor?.kind === 'admin', 403, 'Administrator required');
  check(settings && typeof settings === 'object' && !Array.isArray(settings), 400, 'Invalid weekly settlement settings payload');
  const parsed = weeklySettlementSettingsSchema.safeParse(settings);
  check(parsed.success, 400, parsed.error?.issues?.[0]?.message || 'Invalid weekly settlement settings');
  const v = parsed.data;
  return db.tx(async c => {
    const hasPermission = (await c.query(
      "SELECT 1 FROM permissions WHERE user_id = $1 AND permission = 'finance:configure'",
      [actor.id]
    )).rowCount;
    check(hasPermission, 403, 'Finance configuration permission required');

    const current = await getWeeklySettlementSettings(c);
    const cutoffDay = v.cutoffDayOfWeek ?? current.cutoff_day_of_week;
    const cutoffTime = v.cutoffTimeUtc ?? current.cutoff_time_utc;
    const graceHours = v.graceHours ?? current.grace_hours;
    const commissionBps = v.defaultCommissionBps ?? current.default_commission_bps;
    const reminders = v.remindersEnabled ?? current.reminders_enabled;

    await c.query(`
      UPDATE weekly_settlement_settings
      SET cutoff_day_of_week = $1, cutoff_time_utc = $2, grace_hours = $3,
          default_commission_bps = $4, reminders_enabled = $5, updated_at = now()
      WHERE id = 'default'
    `, [cutoffDay, cutoffTime, graceHours, commissionBps, reminders]);

    await c.query(`
      INSERT INTO audit_logs(actor_id, action, entity_id)
      VALUES($1, 'settlement_settings.updated', $1)
    `, [actor.id]);

    return getWeeklySettlementSettings(c);
  });
}
