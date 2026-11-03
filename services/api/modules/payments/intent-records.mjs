/** Customer checkouts and rider commission payments follow the same provider lifecycle. */
const TABLES=new Set(['shipment_checkout_intents','settlement_intents']);
const known=table=>{if(!TABLES.has(table))throw new Error('Unknown payment intent table');return table;};

export const CONFIRMED_INTENT_FIELDS=`status='confirmed',
            confirmed_at=coalesce(confirmed_at,now()),
            failure_reason=NULL,
            failed_at=NULL,
            provider_terminal_at=now(),
            provider_last_status='success',
            submission_token=NULL,
            submission_lease_until=NULL,
            reconcile_lease_until=NULL,
            last_reconciled_at=now(),
            updated_at=now()`;

/** The provider refused before charging, so the attempt is finished. */
export function markRejectedBeforeCharge(c,table,id,reason,submissionToken){
 return c.query(
  `UPDATE ${known(table)}
      SET status='failed',
          failure_reason=$2,
          failed_at=coalesce(failed_at,now()),
          provider_terminal_at=now(),
          provider_last_status='rejected_before_charge',
          submission_token=NULL,
          submission_lease_until=NULL,
          updated_at=now()
    WHERE id=$1
      AND status='initiating'
      AND submission_token=$3`,
  [id,reason,submissionToken]
 );
}

/**
 * The provider may have accepted the request although the response failed. The token is released so
 * reconciliation can ask the provider; the lease stays so "not_created" is not read as a final failure.
 */
export function markOutcomeUncertain(db,table,id,reason,submissionToken){
 return db.query(
  `UPDATE ${known(table)}
      SET failure_reason=$2,
          submission_token=NULL,
          updated_at=now()
    WHERE id=$1
      AND status='initiating'
      AND submission_token=$3`,
  [id,'Initialization outcome uncertain: '+reason,submissionToken]
 ).catch(()=>{});
}

/** Claims intents with no verified provider result. Backoff grows with age (age/10, capped) to limit provider load. */
export async function claimIntentsToReconcile(db,table,{providerName,limit,leaseSeconds,minimumSeconds,maximumBackoffSeconds}){
 return (await db.query(
  `UPDATE ${known(table)}
      SET reconcile_lease_until=now()+make_interval(secs=>$3)
    WHERE id IN (
      SELECT id FROM ${known(table)}
       WHERE provider=$1
         AND status IN ('initiating','pending','expired','failed')
         AND provider_terminal_at IS NULL
         AND (reconcile_lease_until IS NULL OR reconcile_lease_until<now())
         AND (status<>'initiating' OR submission_token IS NULL OR submission_lease_until IS NULL OR submission_lease_until<=now())
         AND coalesce(last_reconciled_at,submitted_at,updated_at,created_at)
             < now()-make_interval(secs=>greatest($4::double precision,least(extract(epoch FROM now()-created_at)/10,$5::double precision)))
       ORDER BY coalesce(last_reconciled_at,submitted_at,updated_at,created_at) ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
    )
    RETURNING id`,
  [providerName,limit,leaseSeconds,minimumSeconds,maximumBackoffSeconds]
 )).rows;
}

/** Checks older attempts before a new one starts. A failed check must not block the customer. */
export async function reconcileQuietly(candidates,isSubmissionCallActive,reconcile){
 for(const cand of candidates){
  if(!isSubmissionCallActive(cand)){
   try{await reconcile(cand.id);}catch{}
  }
 }
}
