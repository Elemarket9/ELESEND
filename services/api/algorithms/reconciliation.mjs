/** Algorithm 9 — exact double-entry accounting and event-level reconciliation.
 * Complements PostgreSQL uniqueness and immutable journal constraints.
 */
export function verifyBalancedJournal(lines){
 if(!Array.isArray(lines)||lines.length<2)throw Error('A journal requires at least two entries');
 let debits=0n,credits=0n;
 for(const line of lines){
  if(!['debit','credit'].includes(line?.side)||typeof line.ledger_code!=='string'||!line.ledger_code||
    !Number.isSafeInteger(line.amount_minor)||line.amount_minor<=0)throw Error('Invalid financial journal line');
  if(line.side==='debit')debits+=BigInt(line.amount_minor);else credits+=BigInt(line.amount_minor);
 }
 if(debits!==credits)throw Error('Unbalanced journal');
 if(debits>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Journal amount exceeds safe integer limit');
 return {balanced:true,totalMinor:Number(debits)};
}
export function reconcileProviderEvents({intents,confirmedEvents,postedEventIds}={}){
 if(!Array.isArray(intents)||!Array.isArray(confirmedEvents)||!Array.isArray(postedEventIds))throw Error('Invalid reconciliation inputs');
 const byIntent=new Map(intents.map(i=>[i.id,i]));if(byIntent.size!==intents.length)throw Error('Duplicate settlement intent');
 const seen=new Set(),issues=[];const posted=new Set(postedEventIds);
 for(const event of confirmedEvents){
  const id=`${event.provider}:${event.eventId}`;
  if(seen.has(id)){issues.push({eventId:id,reason:'duplicate_event'});continue;}seen.add(id);
  const intent=byIntent.get(event.intentId);
  if(!intent){issues.push({eventId:id,reason:'unknown_intent'});continue;}
  if(intent.provider!==event.provider||intent.amountMinor!==event.amountMinor||intent.currency!==event.currency){
   issues.push({eventId:id,reason:'payment_mismatch'});continue;
  }
  if(event.verified!==true){issues.push({eventId:id,reason:'unverified_provider_event'});continue;}
  if(!posted.has(id))issues.push({eventId:id,reason:'verified_payment_not_posted'});
 }
 for(const id of posted)if(!seen.has(id))issues.push({eventId:id,reason:'journal_without_provider_event'});
 return {ok:issues.length===0,issues,verifiedEvents:[...seen].length};
}
