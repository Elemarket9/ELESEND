/** Algorithm 8 — commission-credit admission; monetary amounts are integer minor units.
 * DB transaction must lock rider commission row before using this decision.
 */
export function decideCommissionExposure({dueMinor,reservedMinor=0,newCommissionMinor,creditMinor=0,limitMinor,
 unpaidJobs=0,activeCashJobs=0,maxUnpaidJobs,postpaidEnabled=true,blocked=false,overdue=false}={}){
 const amounts=[dueMinor,reservedMinor,newCommissionMinor,creditMinor,limitMinor,unpaidJobs,activeCashJobs,maxUnpaidJobs];
 if(amounts.some(x=>!Number.isSafeInteger(x)||x<0))throw Error('Invalid commission exposure amounts');
 const exposure=BigInt(dueMinor)+BigInt(reservedMinor)+BigInt(newCommissionMinor)-BigInt(creditMinor);
 const effective=exposure>0n?exposure:0n;
 const jobs=unpaidJobs+activeCashJobs+(newCommissionMinor>0?1:0);
 const reason=blocked?'account_blocked':overdue?'overdue':!postpaidEnabled&&effective>0n?'prepayment_required':
   effective>BigInt(limitMinor)?'credit_limit':jobs>maxUnpaidJobs&&effective>0n?'unpaid_job_limit':null;
 return {eligible:reason===null,reason,exposureMinor:Number(effective),jobs,limitMinor};
}
