# ELESEND security: standards mapping

This compares ELESEND with public security standards. **It is a self-assessment from reading and testing the code. It is not a certification, and nobody independent has audited or penetration-tested ELESEND.** No system can be made impossible to break, so the aim is that getting through one layer does not give an attacker the next.

Status: **Done** means built, with an automated test where one is named. **Partial** means part is built. **Open** means not built.

## Layers an attacker has to pass

| Layer | What stands there |
| --- | --- |
| Network | Caddy with TLS and HSTS. Internal services sit on a private network. Admin routes are blocked on public hosts, and `ADMIN_ALLOWED_IPS` can close the admin host to everyone but you |
| Request | Size and time limits, rate limits per address, account and API key, strict input checks that refuse unknown fields |
| Identity | Stronger password storage, common passwords refused, administrator authenticator codes, short sessions |
| Permission | Every record is checked against its owner. Staff have named permissions. API keys have scopes and expire |
| Money | Double-entry ledger, one withdrawal at a time, password needed to withdraw, a hold after a payout account changes, no automatic release of unconfirmed payouts |
| Data | Licence and document data and webhook secrets are encrypted. Passwords and session tokens are only stored as hashes |
| Database | Triggers stop audit and financial records being edited. The optional limited login cannot switch those triggers off |
| Record | Audit log, plus one log line for each refused request |

## OWASP API Security Top 10 (2023)

| Risk | Status | How |
| --- | --- | --- |
| API1 Object level authorization | Done | Owner or permission checks on shipments, orders, invitations and keys. `company-integration.test.mjs` covers a rider answering someone else's invitation |
| API2 Broken authentication | Partial | Rate limits, hashed tokens, administrator authenticator codes. Riders, customers and companies have no second factor at sign-in |
| API3 Object property level authorization | Done | Strict input schemas, and limited fields in company and webhook responses |
| API4 Unrestricted resource consumption | Done | Body, header and time limits. Limits per address, account and API key |
| API5 Function level authorization | Done | Admin routes need an administrator and a permission. API keys reach only routes in their scope |
| API6 Unrestricted access to business flows | Partial | Limits on sign-up, SMS, quotes and invitations. No automated bot detection |
| API7 Server-side request forgery | Done | Webhooks need https on the standard port, and the address is checked again when connecting. Redirects are not followed |
| API8 Security misconfiguration | Partial | Production config checks, security headers, containers without extra privileges. The admin and restaurant pages still allow inline scripts |
| API9 Improper inventory management | Partial | Module boundary checks in CI. No published API version policy or generated API description |
| API10 Unsafe consumption of APIs | Done | Payment and identity webhooks are signature-checked, and payment results are confirmed with the provider |

## OWASP ASVS 4.0 (main areas)

| Area | Status | Notes |
| --- | --- | --- |
| V2 Authentication | Partial | 12 character minimum, common password refusal, upgraded scrypt. No check against breached password lists, because that needs an outside service |
| V3 Sessions | Partial | Tokens are random and stored hashed, and end when a password changes. Administrator sessions end after 30 minutes idle or 4 hours. Web portals keep the token in browser storage, so a script injected into a page could read it |
| V4 Access control | Done | See API1 and API5 |
| V5 Input and output | Partial | Parameterized SQL and output escaping in portals. The company page has a strict content policy; the admin and restaurant pages do not yet |
| V6 Cryptography | Done | AES-256-GCM tied to each record, and scrypt |
| V7 Errors and logging | Partial | Clients get no internal detail, logs leave out personal data, and audit records cannot be edited. Logs are not yet sent off the server, and no alerts are set up |
| V9 Communications | Partial | TLS through Caddy and checked database TLS. Mobile certificate pinning is not built |
| V10 Malicious code | Partial | Secret scan and `npm audit` in CI, pinned CI actions, Dependabot |
| V13 API | Done | See the API Top 10 above |
| V14 Configuration | Partial | Base images use version tags rather than exact digests. Containers have not been scanned for vulnerabilities |

## NIST SP 800-63B (passwords and sessions)

| Requirement | Status | How |
| --- | --- | --- |
| Minimum length, long passwords allowed, no forced complexity | Done | 12 to 128 characters |
| Refuse common or compromised passwords | Partial | Offline list of common words and patterns, and the account's own phone number. No breached password database |
| Limit failed attempts | Done | Limits per source and per account |
| Salted, memory-hard storage | Done | Older hashes are upgraded at the next sign-in |
| Stronger login for privileged accounts (AAL2) | Done | Authenticator code with reuse blocked, for administrators |
| Idle and overall session limits | Done | 30 minutes and 4 hours. Other accounts stay signed in while in use and end after 30 days without use |

## NIST CSF 2.0

| Function | Status | Where it stands |
| --- | --- | --- |
| Govern | Open | Needs owner decisions: risk owner, policies and supplier reviews |
| Identify | Partial | Module map and this document. No full data or asset register |
| Protect | Partial | Most of this document |
| Detect | Partial | Refused requests are logged. Nothing watches those logs yet |
| Respond | Open | No written incident plan or breach notification process |
| Recover | Partial | Payments can be reconciled again with the provider. Restoring from a backup has not been rehearsed |

NIST SP 800-53 is written for US federal systems. These controls have direct code behind them: AC-3, AC-6, AU-2, AU-9, IA-2, IA-5, SC-8, SC-13, SC-28, SI-10. Most other families need company processes that code cannot supply.

## Still open, most important first

1. **Independent penetration test** before real customer money goes through ELESEND.
2. **Turn on the limited database login** by setting `ELESEND_APP_DB_PASSWORD` and `DOCKER_APP_DATABASE_URL`. Production startup now refuses a login that owns the tables or is a superuser.
3. **Set `ADMIN_ALLOWED_IPS`** to a fixed office or VPN address.
4. **Strict content policy for the admin and restaurant pages.** This means moving their inline handlers into scripts.
5. **Send logs off the server and alert on them**, so a server takeover cannot hide its own traces.
6. **Second factor for company and restaurant owners,** who receive automatic payouts.
7. **Tested backups and a written incident plan.** Ghana's Data Protection Act 2012 also needs legal review.
8. **Checks against a breached password list, mobile certificate pinning and exact image digests.**
