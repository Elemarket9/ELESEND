/** Cash is collected only at the payer's actual physical handover, never after the state transition. */
export function cashToCollect(shipment,kind,reportedCash={}){
 if(shipment?.payment_method!=='CASH'||reportedCash?.[shipment.id])return null;
 const payer=shipment.cash_payer||'recipient';
 if(!((kind==='pickup'&&payer==='sender')||(kind==='delivery'&&payer==='recipient')))return null;
 const amountMinor=Number(shipment.amount_minor);
 if(!Number.isSafeInteger(amountMinor)||amountMinor<=0)return null;
 return {payer,amountMinor};
}
