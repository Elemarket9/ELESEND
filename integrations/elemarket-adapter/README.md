# Optional ELEMARKET integration: disabled

No patch has been applied to ELEMARKET. There is no shared database, authentication session or runtime import. ELESEND currently accepts only standalone bookings. No production marketplace completion handler exists.

Scoped business API credentials and revocation are implemented for independent quote/booking/read operations. Before enabling the marketplace adapter, add raw-body signed events, timestamp tolerance, a unique event inbox, transactional outbox delivery, retry/dead-letter processing, locked recipient/assigned rider binding and verified end-to-end key rotation procedures.

ELEMARKET remains the authority for its rider-triggered customer OTP and protected order state. A cross-platform receipt must bind order ID, ELESEND shipment ID, actual rider identity, locked recipient, challenge ID and verified completion event. Sender-facing quote and booking calls must not grant completion rights. Ordinary tracking webhooks cannot complete an ELEMARKET order or trigger financial release. The marketplace owns its 24-hour post-receipt protection policy.

The shipment schema reserves `verification_authority='external'`; the database guard rejects completion for it. No API accepts that field. This is a fail-closed extension point, not an implemented cross-platform integration. Never use standalone OTP results as substitute ELEMARKET receipts.
