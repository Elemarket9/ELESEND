/**
 * Rider wallet: a read/write facade over ELESEND's EXISTING immutable ledgers.
 *
 *  - Commission debt  = rider_receivable in finance_journals/finance_lines (per rider).
 *  - Digital earnings = rider_payable in checkout_accounting_journals/lines (per shipment).
 *  - Wallet balance   = unpaid independent-rider earnings - commission debt (signed, may be negative).
 *
 * There is NO editable balance column. Every mutation is a balanced journal posted inside the
 * caller's PostgreSQL transaction while holding the rider's commission_accounts row lock, which is
 * the single serialization point shared with cash-commission posting, repayments, reversals,
 * adjustments, payouts and assignment acceptance.
 *
 * Debt recovery posts two balanced journals that move value between the ledgers through a pair of
 * clearing accounts that must net to zero (verified by walletReconciliation):
 *   rider ledger:    Dr rider_earnings_offset_clearing  Cr rider_receivable   (+ FIFO obligation allocation)
 *   shipment ledger: Dr rider_payable                   Cr rider_debt_recovery_clearing
 */
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check} from './security.mjs';
import {journal,balance,postCashCommission,outstandingObligations,allocateFifo} from './finance.mjs';
import {checkoutJournal,digitalDeliveryCompleted} from './checkout-accounting.mjs';
import {getGhanaWeekKey,getRiderWeeklyBalance,recordSettlementNotification,evaluateRiderWeeklyEligibility} from './weekly-settlement.mjs';

export const REPAYMENT_CHANNELS=['mobile_money','card','bank_transfer','ussd'];
const FINANCE_READ=['finance:read','finance:approve','finance:configure'];
const LIVE_PAYOUT=['initiating','pending','needs_review','paid'];
const IN_FLIGHT_PAYOUT=['proposed','initiating','pending','needs_review'];
const DEFAULT_POLICY=Object.freeze({max_debt_minor:null,debt_restriction_enabled:true,auto_recover_from_earnings:true,repayment_min_minor:100,repayment_max_minor:null,repayment_channels:['mobile_money','card'],revision:0});

const num=v=>v===null||v===undefined?null:Number(v);
async function permit(c,actor,list=FINANCE_READ){
 check(actor?.kind==='admin',403,'Administrator required');
 check((await c.query('SELECT 1 FROM permissions WHERE user_id=$1 AND permission=ANY($2::text[])',[actor.id,list])).rowCount,403,'Finance permission required');
}

export async function getWalletPolicy(c){
 const r=(await c.query("SELECT * FROM rider_wallet_policy WHERE id='default'")).rows[0];
 if(!r)return {...DEFAULT_POLICY};
 return {...r,max_debt_minor:num(r.max_debt_minor),repayment_min_minor:Number(r.repayment_min_minor),repayment_max_minor:num(r.repayment_max_minor),revision:Number(r.revision)};
}
export async function repaymentChannelAllowed(c,channel){
 const p=await getWalletPolicy(c);
 return typeof channel==='string'&&p.repayment_channels.includes(channel);
}

const policySchema=z.object({
 maxDebtMinor:z.number().int().min(0).max(100000000).nullable().optional(),
 debtRestrictionEnabled:z.boolean().optional(),
 autoRecoverFromEarnings:z.boolean().optional(),
 repaymentMinMinor:z.number().int().min(1).max(100000000).optional(),
 repaymentMaxMinor:z.number().int().min(1).max(1000000000).nullable().optional(),
 repaymentChannels:z.array(z.enum(REPAYMENT_CHANNELS)).min(1).max(REPAYMENT_CHANNELS.length).optional(),
 reason:z.string().trim().min(12).max(500)
}).strict();

/** Prospective policy change: permission-controlled, validated, versioned, attributed and audited. */
export async function updateWalletPolicy(db,actor,input){
 const v=policySchema.parse(input);
 check(Object.keys(v).some(k=>k!=='reason'),400,'No policy change supplied');
 return db.tx(async c=>{
  await permit(c,actor,['finance:configure']);
  await c.query("INSERT INTO rider_wallet_policy(id) VALUES('default') ON CONFLICT DO NOTHING");
  const cur=(await c.query("SELECT * FROM rider_wallet_policy WHERE id='default' FOR UPDATE")).rows[0];
  const next={
   max_debt_minor:v.maxDebtMinor!==undefined?v.maxDebtMinor:num(cur.max_debt_minor),
   debt_restriction_enabled:v.debtRestrictionEnabled??cur.debt_restriction_enabled,
   auto_recover_from_earnings:v.autoRecoverFromEarnings??cur.auto_recover_from_earnings,
   repayment_min_minor:v.repaymentMinMinor??Number(cur.repayment_min_minor),
   repayment_max_minor:v.repaymentMaxMinor!==undefined?v.repaymentMaxMinor:num(cur.repayment_max_minor),
   repayment_channels:v.repaymentChannels?[...new Set(v.repaymentChannels)]:cur.repayment_channels
  };
  check(next.repayment_max_minor===null||next.repayment_max_minor>=next.repayment_min_minor,400,'Maximum repayment must not be below the minimum');
  const revision=Number(cur.revision)+1;
  await c.query(`UPDATE rider_wallet_policy SET max_debt_minor=$1,debt_restriction_enabled=$2,auto_recover_from_earnings=$3,
    repayment_min_minor=$4,repayment_max_minor=$5,repayment_channels=$6,revision=$7,updated_by=$8,updated_at=now() WHERE id='default'`,
   [next.max_debt_minor,next.debt_restriction_enabled,next.auto_recover_from_earnings,next.repayment_min_minor,next.repayment_max_minor,next.repayment_channels,revision,actor.id]);
  await c.query('INSERT INTO rider_wallet_policy_history(revision,policy,changed_by,reason) VALUES($1,$2,$3,$4)',[revision,JSON.stringify(next),actor.id,v.reason]);
  await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'finance.rider_wallet_policy_updated',$1)",[actor.id]);
  return getWalletPolicy(c);
 });
}
export async function walletPolicyView(db,actor){
 await permit(db,actor);
 const policy=await getWalletPolicy(db);
 const history=(await db.query('SELECT revision,policy,changed_by,reason,changed_at FROM rider_wallet_policy_history ORDER BY revision DESC LIMIT 50')).rows;
 return {policy,history};
}

async function ensureAccount(c,riderId){await c.query('INSERT INTO commission_accounts(rider_id) VALUES($1) ON CONFLICT DO NOTHING',[riderId]);}
async function accountRow(c,riderId,{lock=false}={}){
 await ensureAccount(c,riderId);
 return (await c.query(`SELECT * FROM commission_accounts WHERE rider_id=$1${lock?' FOR UPDATE':''}`,[riderId])).rows[0];
}

/** Deterministic lock order for wallet-affecting paths: rider commission account BEFORE any shipment row. */
export async function lockRiderAccount(c,riderId){return accountRow(c,riderId,{lock:true});}

/** Debt-limit state; callers needing race-free decisions pass lock:true inside a transaction. */
export async function debtState(c,riderId,{lock=false}={}){
 const account=await accountRow(c,riderId,{lock});
 const policy=await getWalletPolicy(c);
 const b=await balance(c,riderId);
 const limitMinor=policy.max_debt_minor??Number(account.max_outstanding_minor);
 const debtMinor=Math.max(0,b.dueMinor);
 const restricted=policy.debt_restriction_enabled&&debtMinor>0&&debtMinor>=limitMinor;
 return {debtMinor,limitMinor,restricted,restrictionEnabled:policy.debt_restriction_enabled,policyRevision:policy.revision};
}

/** All independent restrictions are reported; none is cleared by another. */
export async function assignmentEligibility(c,riderId,{lock=false}={}){
 const rider=(await c.query('SELECT id,status,financial_restriction,company_id FROM riders WHERE id=$1',[riderId])).rows[0];
 if(!rider)return {eligible:false,restrictions:[{code:'RIDER_NOT_FOUND'}]};
 const restrictions=[];
 if(rider.status!=='approved')restrictions.push({code:'ACCOUNT_STATUS',status:rider.status});
 if(rider.company_id){
  const company=(await c.query('SELECT status FROM companies WHERE id=$1',[rider.company_id])).rows[0];
  if(!company||company.status!=='approved')restrictions.push({code:'COMPANY_STATUS',status:company?.status??'missing'});
 }
 const debt=await debtState(c,riderId,{lock});
 const weekly=await evaluateRiderWeeklyEligibility(c,riderId);
 if(!weekly.eligible)restrictions.push({code:weekly.reason||'OVERDUE_CASH_COMMISSION',overdueMinor:weekly.overdueMinor??0});
 if(debt.restricted)restrictions.push({code:'DEBT_LIMIT_REACHED',debtMinor:debt.debtMinor,limitMinor:debt.limitMinor});
 return {eligible:restrictions.length===0,restrictions,debtMinor:debt.debtMinor,debtLimitMinor:debt.limitMinor,debtRestricted:debt.restricted};
}
/** Server-side gate for EVERY new assignment path (cash and digital). Locks the commission account. */
export async function requireDebtEligible(c,riderId){
 const d=await debtState(c,riderId,{lock:true});
 check(!d.restricted,409,`Rider assignment restricted: DEBT_LIMIT_REACHED (outstanding ${d.debtMinor} >= limit ${d.limitMinor} pesewas). Repay commission to restore new assignments.`);
 return d;
}

async function emitDebtTransition(c,riderId,before,after){
 if(!before||!after||before.restricted===after.restricted)return;
 const weekKey=getGhanaWeekKey(new Date());
 if(after.restricted){
  await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES(NULL,'wallet.debt_restriction_applied',$1)",[riderId]);
  await recordSettlementNotification(c,{riderId,type:'DEBT_LIMIT_RESTRICTION',weekKey,recipient:riderId,message:`ELESEND: Your commission balance (GH₵${(after.debtMinor/100).toFixed(2)}) reached the GH₵${(after.limitMinor/100).toFixed(2)} limit. New deliveries are paused until you repay. You can still repay, view history and finish current jobs.`,metadata:{debtMinor:after.debtMinor,limitMinor:after.limitMinor}});
 }else{
  await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES(NULL,'wallet.debt_restriction_lifted',$1)",[riderId]);
  await recordSettlementNotification(c,{riderId,type:'DEBT_LIMIT_RESTORED',weekKey,recipient:riderId,message:'ELESEND: Your commission balance is below the limit. New delivery offers are restored (other account checks still apply).',metadata:{debtMinor:after.debtMinor,limitMinor:after.limitMinor}});
 }
}
export {emitDebtTransition};

/** Clears ONLY the overdue-cash-commission flag, never fraud/identity/safety/operational suspensions. */
export async function refreshFinancialRestriction(c,riderId){
 const weekly=await getRiderWeeklyBalance(c,riderId);
 if(weekly.overdueMinor===0){
  const r=await c.query("UPDATE riders SET financial_restriction=NULL,financial_restriction_at=NULL WHERE id=$1 AND financial_restriction='OVERDUE_CASH_COMMISSION' RETURNING id",[riderId]);
  if(r.rowCount)await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'rider.restriction_cleared_cash_commission',$1)",[riderId]);
 }
 return weekly;
}

/** Unpaid earnings that belong to the rider personally (company riders' earnings belong to the company). */
async function recoverableEarnings(c,riderId){
 return (await c.query(`SELECT j.shipment_id,
    sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END)::bigint AS payable_minor,
    min(s.completed_at) AS completed_at
   FROM checkout_accounting_lines l
   JOIN checkout_accounting_journals j ON j.id=l.journal_id
   JOIN shipments s ON s.id=j.shipment_id
  WHERE l.account='rider_payable' AND s.rider_id=$1 AND s.company_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM payout_operations p WHERE p.shipment_id=j.shipment_id AND p.kind='rider' AND p.status=ANY($2::text[]))
  GROUP BY j.shipment_id
  HAVING sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END)>0
  ORDER BY min(s.completed_at) NULLS LAST,j.shipment_id`,[riderId,LIVE_PAYOUT])).rows.map(r=>({shipmentId:r.shipment_id,payableMinor:Number(r.payable_minor)}));
}

/**
 * Atomically applies verified, unpaid digital earnings to outstanding commission debt.
 * Must run inside the caller's transaction. Idempotent by construction: amounts are derived from
 * immutable ledger state under the rider account lock, so a repeated call recovers 0.
 */
export async function recoverDebtFromEarnings(c,riderId,{trigger='delivery_earnings'}={}){
 await accountRow(c,riderId,{lock:true});
 const policy=await getWalletPolicy(c);
 if(!policy.auto_recover_from_earnings)return {recoveredMinor:0,disabled:true,entries:[]};
 const due=(await balance(c,riderId)).dueMinor;
 const allocatable=(await outstandingObligations(c,riderId)).reduce((s,o)=>s+o.remainingMinor,0);
 let remaining=Math.min(due,allocatable);
 const entries=[];
 if(remaining<=0)return {recoveredMinor:0,entries};
 for(const src of await recoverableEarnings(c,riderId)){
  if(remaining<=0)break;
  const chunk=Math.min(remaining,src.payableMinor);
  const seq=Number((await c.query('SELECT coalesce(max(seq),0)+1 AS n FROM rider_debt_recoveries WHERE shipment_id=$1',[src.shipmentId])).rows[0].n);
  const eventKey=`earnings-recovery:${src.shipmentId}:${seq}`;
  const fj=await journal(c,{eventKey,riderId,shipmentId:src.shipmentId,kind:'earnings_recovery',value:chunk});
  check(!fj.duplicate,409,'Debt recovery sequence conflict; retry');
  await allocateFifo(c,riderId,fj.id,chunk);
  const cj=await checkoutJournal(c,{shipmentId:src.shipmentId,eventKey,kind:'rider_debt_recovered',entries:[['rider_payable','debit',chunk],['rider_debt_recovery_clearing','credit',chunk]]});
  check(!cj.duplicate,409,'Debt recovery sequence conflict; retry');
  await c.query('INSERT INTO rider_debt_recoveries(id,rider_id,shipment_id,seq,amount_minor,finance_journal_id,checkout_journal_id,trigger_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
   [randomUUID(),riderId,src.shipmentId,seq,chunk,fj.id,cj.id,trigger]);
  entries.push({shipmentId:src.shipmentId,amountMinor:chunk});
  remaining-=chunk;
 }
 const recoveredMinor=entries.reduce((s,e)=>s+e.amountMinor,0);
 if(recoveredMinor>0){
  await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES(NULL,'wallet.debt_recovered_from_earnings',$1)",[riderId]);
  await refreshFinancialRestriction(c,riderId);
 }
 return {recoveredMinor,entries};
}

/**
 * Single settlement entry point after an OTP-verified delivery (called inside the completion tx).
 * CASH: commission becomes rider debt exactly once (event-keyed), then any unpaid digital earnings offset it.
 * DIGITAL: verified-payment earnings are credited exactly once, then offset any outstanding debt.
 */
export async function settleCompletedDelivery(c,shipment){
 check(shipment?.id&&shipment.rider_id,409,'Completed delivery requires an assigned rider');
 const independent=!shipment.company_id;
 const before=await debtState(c,shipment.rider_id,{lock:true});
 const out={};
 if(shipment.payment_method==='CASH')out.cashCommission=await postCashCommission(c,shipment);
 else out.digitalSettlement=await digitalDeliveryCompleted(c,shipment);
 if(independent)out.recovery=await recoverDebtFromEarnings(c,shipment.rider_id,{trigger:shipment.payment_method==='CASH'?'new_commission_debt':'delivery_earnings'});
 const after=await debtState(c,shipment.rider_id);
 await emitDebtTransition(c,shipment.rider_id,before,after);
 out.debt=after;
 return out;
}

async function earningsBreakdown(c,riderId){
 const rows=(await c.query(`SELECT j.shipment_id,s.company_id,
    sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END)::bigint AS payable_minor,
    (SELECT p.status FROM payout_operations p WHERE p.shipment_id=j.shipment_id AND p.kind='rider' AND p.status NOT IN ('failed','superseded') ORDER BY p.created_at DESC LIMIT 1) AS payout_status
   FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id JOIN shipments s ON s.id=j.shipment_id
  WHERE l.account='rider_payable' AND s.rider_id=$1 GROUP BY j.shipment_id,s.company_id`,[riderId])).rows;
 let payable=0,inPayout=0,company=0;
 for(const r of rows){
  const amt=Number(r.payable_minor);if(amt<=0)continue;
  if(r.company_id){company+=amt;continue;}
  payable+=amt;
  if(IN_FLIGHT_PAYOUT.includes(r.payout_status))inPayout+=amt;
 }
 return {payableMinor:payable,inPayoutMinor:inPayout,companyEarningsMinor:company};
}

export async function walletSummary(db,actor){
 check(actor?.kind==='rider',403,'Rider account required');
 const riderId=actor.id;
 const b=await balance(db,riderId);
 const debt=await debtState(db,riderId);
 const elig=await assignmentEligibility(db,riderId);
 const policy=await getWalletPolicy(db);
 const e=await earningsBreakdown(db,riderId);
 const debtMinor=debt.debtMinor;
 const walletBalanceMinor=e.payableMinor-debtMinor;
 const withdrawableMinor=debtMinor>0?0:Math.max(0,e.payableMinor-e.inPayoutMinor);
 const totals=(await db.query(`SELECT
   coalesce((SELECT sum(amount_minor) FROM rider_debt_recoveries WHERE rider_id=$1),0)::bigint AS recovered,
   coalesce((SELECT sum(l.amount_minor) FROM finance_journals j JOIN finance_lines l ON l.journal_id=j.id WHERE j.rider_id=$1 AND j.kind='commission_repayment' AND l.ledger_code='rider_receivable'),0)::bigint AS repaid,
   coalesce((SELECT sum(l.amount_minor) FROM finance_journals j JOIN finance_lines l ON l.journal_id=j.id WHERE j.rider_id=$1 AND j.kind='cash_commission' AND l.ledger_code='rider_receivable'),0)::bigint AS cash_commission`,[riderId])).rows[0];
 return {
  currency:'GHS',
  walletBalanceMinor,
  availableEarningsMinor:e.payableMinor,
  inPayoutMinor:e.inPayoutMinor,
  withdrawableMinor,
  outstandingDebtMinor:debtMinor,
  debtLimitMinor:debt.limitMinor,
  debtRestricted:debt.restricted,
  remainingBeforeRestrictionMinor:debt.restrictionEnabled?Math.max(0,debt.limitMinor-debtMinor):null,
  companyEarningsMinor:e.companyEarningsMinor,
  unappliedProviderMinor:b.unappliedProviderMinor,
  assignmentEligible:elig.eligible,
  restrictions:elig.restrictions,
  lifetime:{debtRecoveredFromEarningsMinor:Number(totals.recovered),repaidMinor:Number(totals.repaid),cashCommissionAssessedMinor:Number(totals.cash_commission)},
  repayment:{minMinor:policy.repayment_min_minor,maxMinor:policy.repayment_max_minor,channels:policy.repayment_channels,canRepay:debtMinor>0},
  notes:[
   'Balances are derived from ELESEND ledgers on the server; the app never calculates them.',
   'Digital earnings are applied to commission debt automatically before anything becomes withdrawable.',
   e.companyEarningsMinor>0?'Earnings from company-assigned jobs belong to your fleet company and are paid to its verified account.':null
  ].filter(Boolean)
 };
}

export async function walletDebt(db,actor){
 check(actor?.kind==='rider',403,'Rider account required');
 const riderId=actor.id;
 const debt=await debtState(db,riderId);
 const weekly=await getRiderWeeklyBalance(db,riderId);
 const obligations=(await outstandingObligations(db,riderId)).map(o=>({obligationId:o.id,originalMinor:Number(o.original_minor),remainingMinor:o.remainingMinor,dueAt:o.due_at,createdAt:o.created_at}));
 const elig=await assignmentEligibility(db,riderId);
 return {currency:'GHS',outstandingDebtMinor:debt.debtMinor,debtLimitMinor:debt.limitMinor,debtRestricted:debt.restricted,overdueMinor:weekly.overdueMinor,currentWeekAccruedMinor:weekly.currentWeekAccruedMinor,obligations,restrictions:elig.restrictions};
}

const TX_TYPES={cash_commission:['cash_commission',-1,1],commission_repayment:['debt_repayment',1,-1],waive:['debt_waiver',1,-1],reinstate:['debt_reinstated',-1,1],earnings_recovery:['debt_recovered_from_earnings',0,-1],commission_overpayment:['overpayment_held_for_refund',0,0],credit_purchase:['prepaid_credit',0,0],credit_apply:['prepaid_credit_applied',1,-1]};
export async function walletTransactions(db,actor,{limit=100}={}){
 check(actor?.kind==='rider',403,'Rider account required');
 const riderId=actor.id;
 const n=Math.min(Math.max(Number.parseInt(limit,10)||100,1),200);
 const fin=(await db.query(`SELECT j.id,j.kind,j.shipment_id,j.event_key,j.created_at,
    coalesce(sum(l.amount_minor) FILTER(WHERE l.ledger_code='rider_receivable'),max(l.amount_minor))::bigint AS amount_minor
   FROM finance_journals j JOIN finance_lines l ON l.journal_id=j.id WHERE j.rider_id=$1
   GROUP BY j.id ORDER BY j.created_at DESC LIMIT $2`,[riderId,n])).rows;
 const earn=(await db.query(`SELECT j.id,j.kind,j.shipment_id,j.created_at,
    sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END)::bigint AS net_minor
   FROM checkout_accounting_journals j JOIN checkout_accounting_lines l ON l.journal_id=j.id JOIN shipments s ON s.id=j.shipment_id
  WHERE l.account='rider_payable' AND s.rider_id=$1 AND s.company_id IS NULL AND j.kind IN ('delivery_completed','payout_completed')
  GROUP BY j.id ORDER BY j.created_at DESC LIMIT $2`,[riderId,n])).rows;
 const items=[];
 for(const r of fin){
  const [type,walletSign,debtSign]=TX_TYPES[r.kind]??[r.kind,0,0];const amt=Number(r.amount_minor);
  items.push({id:r.id,source:'commission_ledger',type,shipmentId:r.shipment_id,amountMinor:amt,walletEffectMinor:walletSign*amt,debtEffectMinor:debtSign*amt,earningsEffectMinor:r.kind==='earnings_recovery'?-amt:0,at:r.created_at});
 }
 for(const r of earn){
  const amt=Math.abs(Number(r.net_minor));if(!amt)continue;
  const type=r.kind==='delivery_completed'?'digital_delivery_earnings':'withdrawal_paid';
  const sign=r.kind==='delivery_completed'?1:-1;
  items.push({id:r.id,source:'earnings_ledger',type,shipmentId:r.shipment_id,amountMinor:amt,walletEffectMinor:sign*amt,debtEffectMinor:0,earningsEffectMinor:sign*amt,at:r.created_at});
 }
 items.sort((a,b)=>new Date(b.at)-new Date(a.at));
 return {currency:'GHS',items:items.slice(0,n)};
}

/** Reconciled platform-wide totals for authorized finance roles (no secrets, no client arithmetic). */
export async function adminWalletOverview(db,actor){
 await permit(db,actor);
 const q=async(sql,p=[])=>(await db.query(sql,p)).rows[0];
 const sumAcct=account=>q(`SELECT coalesce(sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END),0)::bigint AS v FROM checkout_accounting_lines l WHERE l.account=$1`,[account]);
 const [digitalCommission,foodCommission,riderPayable]=await Promise.all([sumAcct('platform_commission_revenue'),sumAcct('platform_food_commission_revenue'),sumAcct('rider_payable')]);
 const cashCommission=await q(`SELECT coalesce(sum(l.amount_minor),0)::bigint AS v FROM finance_lines l JOIN finance_journals j ON j.id=l.journal_id WHERE j.kind='cash_commission' AND l.ledger_code='platform_revenue' AND l.side='credit'`);
 const digitalEarnings=await q(`SELECT coalesce(sum(l.amount_minor),0)::bigint AS v FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE j.kind='delivery_completed' AND l.account='rider_payable' AND l.side='credit'`);
 const debt=await q(`SELECT coalesce(sum(outstanding_debt_minor) FILTER(WHERE outstanding_debt_minor>0),0)::bigint AS outstanding,count(*) FILTER(WHERE debt_restricted)::int AS restricted,count(*) FILTER(WHERE outstanding_debt_minor>0)::int AS indebted FROM rider_debt_profiles`);
 const recovered=await q('SELECT coalesce(sum(amount_minor),0)::bigint AS v,count(*)::int AS n FROM rider_debt_recoveries');
 const topups=await q(`SELECT count(*) FILTER(WHERE status='confirmed')::int AS confirmed,coalesce(sum(amount_minor) FILTER(WHERE status='confirmed'),0)::bigint AS confirmed_minor,
   count(*) FILTER(WHERE status IN ('failed','rejected'))::int AS failed,count(*) FILTER(WHERE status='reversed')::int AS reversed,
   count(*) FILTER(WHERE status IN ('initiating','pending'))::int AS pending,count(*) FILTER(WHERE status='expired' AND provider_terminal_at IS NULL)::int AS expired_unverified
   FROM settlement_intents WHERE kind='commission_repayment'`);
 const unreconciled=await q(`SELECT
   (SELECT count(*) FROM settlement_intents WHERE provider_terminal_at IS NULL AND status IN ('initiating','pending','expired','failed') AND created_at<now()-interval '1 hour')::int AS settlement,
   (SELECT count(*) FROM shipment_checkout_intents WHERE provider_terminal_at IS NULL AND status IN ('initiating','pending','expired','failed') AND created_at<now()-interval '1 hour')::int AS checkout,
   (SELECT count(*) FROM checkout_unapplied_payments)::int AS unapplied_checkout,
   (SELECT count(*) FROM refund_operations WHERE status IN ('needs_review','failed'))::int AS refunds,
   (SELECT count(*) FROM payout_operations WHERE status IN ('needs_review','failed'))::int AS payouts`);
 const policy=await getWalletPolicy(db);
 return {
  currency:'GHS',
  recognizedDeliveryCommissionMinor:{digital:Number(digitalCommission.v),cash:Number(cashCommission.v),total:Number(digitalCommission.v)+Number(cashCommission.v)},
  recognizedRestaurantCommissionMinor:Number(foodCommission.v),
  outstandingRiderDebtMinor:Number(debt.outstanding),
  indebtedRiders:debt.indebted,
  ridersRestrictedByDebt:debt.restricted,
  debtRecoveredFromEarnings:{totalMinor:Number(recovered.v),entries:recovered.n},
  topups:{confirmed:topups.confirmed,confirmedMinor:Number(topups.confirmed_minor),failed:topups.failed,reversed:topups.reversed,pending:topups.pending,expiredUnverified:topups.expired_unverified},
  digitalDeliveryEarningsMinor:Number(digitalEarnings.v),
  unpaidRiderEarningsMinor:Number(riderPayable.v),
  cashCommissionReceivablesMinor:Number(debt.outstanding),
  unreconciled:{settlementIntents:unreconciled.settlement,checkoutIntents:unreconciled.checkout,unappliedCheckoutPayments:unreconciled.unapplied_checkout,refundExceptions:unreconciled.refunds,payoutExceptions:unreconciled.payouts},
  policy
 };
}

/**
 * Read-only consistency checks over the immutable ledgers. Never rewrites history; corrective action
 * is either the idempotent recovery job (UNRECOVERED_DEBT_WITH_EARNINGS) or an audited adjustment.
 */
export async function walletReconciliation(c){
 const anomalies=[];
 const add=(code,severity,rows,extra={})=>{if(rows.length)anomalies.push({code,severity,count:rows.length,sample:rows.slice(0,20),...extra});};
 const clearing=(await c.query(`SELECT
   (SELECT coalesce(sum(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END),0) FROM finance_lines WHERE ledger_code='rider_earnings_offset_clearing')::bigint AS rider_side,
   (SELECT coalesce(sum(CASE WHEN side='credit' THEN amount_minor ELSE -amount_minor END),0) FROM checkout_accounting_lines WHERE account='rider_debt_recovery_clearing')::bigint AS shipment_side,
   (SELECT coalesce(sum(amount_minor),0) FROM rider_debt_recoveries)::bigint AS evidence`)).rows[0];
 if(!(clearing.rider_side===clearing.shipment_side&&clearing.shipment_side===clearing.evidence))
  anomalies.push({code:'RECOVERY_CLEARING_MISMATCH',severity:'critical',count:1,sample:[{riderSideMinor:Number(clearing.rider_side),shipmentSideMinor:Number(clearing.shipment_side),evidenceMinor:Number(clearing.evidence)}]});
 add('RECOVERY_EVIDENCE_MISMATCH','critical',(await c.query(`SELECT r.id,r.amount_minor FROM rider_debt_recoveries r
   WHERE r.amount_minor<>(SELECT coalesce(sum(amount_minor),0) FROM finance_lines WHERE journal_id=r.finance_journal_id AND ledger_code='rider_receivable' AND side='credit')
      OR r.amount_minor<>(SELECT coalesce(sum(amount_minor),0) FROM checkout_accounting_lines WHERE journal_id=r.checkout_journal_id AND account='rider_payable' AND side='debit') LIMIT 50`)).rows);
 add('COD_COMPLETED_WITHOUT_COMMISSION','high',(await c.query(`SELECT s.id AS shipment_id,s.rider_id,s.commission_minor FROM shipments s
   WHERE s.payment_method='CASH' AND s.state='COMPLETED' AND s.commission_minor>0 AND s.rider_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM finance_journals j WHERE j.event_key='shipment:'||s.id||':cash-commission') LIMIT 50`)).rows);
 add('DIGITAL_COMPLETED_WITHOUT_SETTLEMENT','high',(await c.query(`SELECT s.id AS shipment_id,s.rider_id FROM shipments s
   WHERE s.payment_method<>'CASH' AND s.state='COMPLETED'
     AND EXISTS(SELECT 1 FROM shipment_checkout_intents i WHERE i.shipment_id=s.id AND i.status='confirmed')
     AND NOT EXISTS(SELECT 1 FROM checkout_accounting_journals j WHERE j.event_key='delivery:'||s.id||':digitally-completed') LIMIT 50`)).rows);
 add('DEBT_OBLIGATION_MISMATCH','high',(await c.query(`WITH r AS (
    SELECT j.rider_id,sum(CASE WHEN l.ledger_code='rider_receivable' AND l.side='debit' THEN l.amount_minor WHEN l.ledger_code='rider_receivable' AND l.side='credit' THEN -l.amount_minor ELSE 0 END) AS receivable
      FROM finance_journals j JOIN finance_lines l ON l.journal_id=j.id GROUP BY j.rider_id),
   o AS (SELECT ob.rider_id,sum(ob.original_minor-coalesce((SELECT sum(a.amount_minor) FROM commission_allocations a WHERE a.obligation_id=ob.id),0)) AS remaining
      FROM commission_obligations ob GROUP BY ob.rider_id)
   SELECT coalesce(r.rider_id,o.rider_id) AS rider_id,coalesce(r.receivable,0)::bigint AS receivable_minor,coalesce(o.remaining,0)::bigint AS obligations_minor
     FROM r FULL JOIN o ON o.rider_id=r.rider_id WHERE coalesce(r.receivable,0)<>coalesce(o.remaining,0) LIMIT 50`)).rows);
 add('CONFIRMED_TOPUP_WITHOUT_EVIDENCE','critical',(await c.query(`SELECT i.id,i.rider_id,i.amount_minor FROM settlement_intents i
   WHERE i.status='confirmed' AND NOT EXISTS(SELECT 1 FROM settlement_provider_events e WHERE e.intent_id=i.id) LIMIT 50`)).rows);
 add('NEGATIVE_RIDER_PAYABLE','critical',(await c.query(`SELECT j.shipment_id,sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END)::bigint AS net_minor
   FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE l.account='rider_payable'
   GROUP BY j.shipment_id HAVING sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END)<0 LIMIT 50`)).rows);
 add('REFUND_WITHOUT_ACCOUNTING_REVERSAL','high',(await c.query(`SELECT r.id,r.shipment_id FROM refund_operations r WHERE r.status='refunded'
   AND NOT EXISTS(SELECT 1 FROM checkout_accounting_journals j WHERE j.shipment_id=r.shipment_id AND j.kind='refund_completed') LIMIT 50`)).rows);
 add('PAID_FOOD_WITHOUT_VERIFIED_PAYMENT','critical',(await c.query(`SELECT f.id,f.shipment_id FROM food_orders f WHERE f.payment_status='PAID'
   AND NOT EXISTS(SELECT 1 FROM shipment_checkout_intents i WHERE i.shipment_id=f.shipment_id AND i.status='confirmed' AND i.amount_minor=f.total_minor) LIMIT 50`)).rows);
 add('LEGACY_CASH_FOOD_ORDER','medium',(await c.query(`SELECT f.id,f.shipment_id,f.state,f.payment_status FROM food_orders f JOIN shipments s ON s.id=f.shipment_id
   WHERE (s.payment_method='CASH' OR f.payment_method='CASH') AND f.state NOT IN ('CANCELLED','REJECTED') LIMIT 50`)).rows,{action:'Cancel through the food order cancellation flow; these orders cannot be dispatched'});
 const policy=await getWalletPolicy(c);
 if(policy.auto_recover_from_earnings){
  add('UNRECOVERED_DEBT_WITH_EARNINGS','medium',(await c.query(`WITH debt AS (
     SELECT j.rider_id,sum(CASE WHEN l.ledger_code='rider_receivable' AND l.side='debit' THEN l.amount_minor WHEN l.ledger_code='rider_receivable' AND l.side='credit' THEN -l.amount_minor ELSE 0 END) AS due
       FROM finance_journals j JOIN finance_lines l ON l.journal_id=j.id GROUP BY j.rider_id),
    earn AS (
     SELECT s.rider_id,sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END) AS payable
       FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id JOIN shipments s ON s.id=j.shipment_id
      WHERE l.account='rider_payable' AND s.company_id IS NULL AND s.rider_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM payout_operations p WHERE p.shipment_id=j.shipment_id AND p.kind='rider' AND p.status=ANY($1::text[]))
      GROUP BY s.rider_id)
    SELECT d.rider_id,d.due::bigint AS debt_minor,e.payable::bigint AS earnings_minor FROM debt d JOIN earn e ON e.rider_id=d.rider_id WHERE d.due>0 AND e.payable>0 LIMIT 50`,[LIVE_PAYOUT])).rows,{autoRecoverable:true});
 }
 add('UNVERIFIED_PAYMENTS_OVER_1H','medium',(await c.query(`SELECT 'settlement' AS kind,id,status,created_at FROM settlement_intents WHERE provider_terminal_at IS NULL AND status IN ('initiating','pending','expired','failed') AND created_at<now()-interval '1 hour'
   UNION ALL SELECT 'checkout',id,status,created_at FROM shipment_checkout_intents WHERE provider_terminal_at IS NULL AND status IN ('initiating','pending','expired','failed') AND created_at<now()-interval '1 hour' LIMIT 50`)).rows);
 add('UNAPPLIED_CUSTOMER_PAYMENTS','medium',(await c.query('SELECT provider,event_id,shipment_id,amount_minor,reason FROM checkout_unapplied_payments ORDER BY created_at LIMIT 50')).rows);
 const rank={critical:0,high:1,medium:2,low:3};
 anomalies.sort((a,b)=>rank[a.severity]-rank[b.severity]);
 return {ok:!anomalies.some(a=>a.severity==='critical'||a.severity==='high'),checkedAt:new Date().toISOString(),anomalies};
}
export async function adminWalletReconciliation(db,actor){await permit(db,actor);return walletReconciliation(db);}

/** Scheduled, idempotent catch-up for recoveries that a crashed or legacy path missed. */
export async function runScheduledRecovery(db,{limit=50}={}){
 const report=await walletReconciliation(db);
 const results=[];
 const pending=report.anomalies.find(a=>a.code==='UNRECOVERED_DEBT_WITH_EARNINGS');
 for(const row of (pending?.sample??[]).slice(0,limit)){
  try{results.push({riderId:row.rider_id,...await db.tx(c=>recoverDebtFromEarnings(c,row.rider_id,{trigger:'scheduled_recovery'}))});}
  catch(e){results.push({riderId:row.rider_id,error:e.status??'error'});}
 }
 return {report,results};
}
