import {envInt} from '../../env-values.mjs';
/**
 * Cash commission on company jobs is owed by the company, which receives those jobs' earnings.
 * The balance is derived from the immutable shipment ledger, with no editable debt column.
 */
import {checkoutJournal} from './checkout-accounting.mjs';

const ACCOUNT='company_commission_receivable';
export const companyDebtLimitMinor=()=>envInt(process.env.COMPANY_COMMISSION_DEBT_LIMIT_MINOR,50000,0);
export async function companyDebtMinor(c,companyId){
 return Number((await c.query(`SELECT coalesce(sum(CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END),0)::bigint AS debt
   FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id JOIN shipments s ON s.id=j.shipment_id
  WHERE l.account=$1 AND s.company_id=$2`,[ACCOUNT,companyId])).rows[0].debt);
}
export async function assessCompanyCashCommission(c,shipment){
 const amount=Number(shipment.commission_minor);
 if(amount<=0)return {zeroCommission:true};
 return checkoutJournal(c,{shipmentId:shipment.id,eventKey:'company-cash-commission:'+shipment.id,kind:'company_commission_assessed',
  entries:[[ACCOUNT,'debit',amount],['platform_commission_revenue','credit',amount]]});
}
/** Takes what the company owes from its unpaid earnings, oldest first, under the company lock. */
export async function recoverCompanyDebt(c,companyId){
 await c.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[companyId]);
 let remaining=await companyDebtMinor(c,companyId);
 const entries=[];
 if(remaining<=0)return {recoveredMinor:0,entries};
 const earnings=(await c.query(`SELECT j.shipment_id,sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END)::bigint AS payable
   FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id JOIN shipments s ON s.id=j.shipment_id
  WHERE l.account='rider_payable' AND s.company_id=$1
    AND NOT EXISTS(SELECT 1 FROM payout_operations p WHERE p.shipment_id=j.shipment_id AND p.kind='rider' AND p.status NOT IN ('failed','superseded'))
  GROUP BY j.shipment_id HAVING sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END)>0
  ORDER BY min(j.created_at),j.shipment_id`,[companyId])).rows;
 for(const e of earnings){
  if(remaining<=0)break;
  const chunk=Math.min(remaining,Number(e.payable));
  const seq=Number((await c.query("SELECT count(*)::int AS n FROM checkout_accounting_journals WHERE shipment_id=$1 AND kind='company_commission_recovered'",[e.shipment_id])).rows[0].n)+1;
  await checkoutJournal(c,{shipmentId:e.shipment_id,eventKey:`company-commission-recovery:${e.shipment_id}:${seq}`,kind:'company_commission_recovered',
   entries:[['rider_payable','debit',chunk],[ACCOUNT,'credit',chunk]]});
  entries.push({shipmentId:e.shipment_id,amountMinor:chunk});
  remaining-=chunk;
 }
 return {recoveredMinor:entries.reduce((s,e)=>s+e.amountMinor,0),entries};
}
