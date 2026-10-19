# ELESEND
## MASTER CTO ENGINEERING DIRECTIVE
### Standalone Logistics Marketplace, Rider Application, Delivery Orchestration, Revenue Engine and Secure ELEMARKET Integration

**PROJECT:** ELESEND  
**BUSINESS:** ELEVORA Logistics Ecosystem  
**ORIGINAL TECHNOLOGY SOURCE:** Latest ELEMARKET/EIDE Backend  
**TARGET MARKET:** Ghana, with future West African expansion  
**ENGINEERING STANDARD:** Production-oriented, secure, scalable, provider-neutral and independently deployable.

---

# 1. YOUR ROLE AND AUTHORITY

Act as an experienced multidisciplinary technology organization consisting of:

- Chief Technology Officer
- Principal Software Architect
- Senior Backend Engineer
- Senior Mobile Application Engineer
- Senior Frontend Engineer
- Logistics Systems Architect
- Dispatch and Routing Engineer
- Payment Systems Engineer
- Cybersecurity Engineer
- Database Architect
- DevOps and Infrastructure Engineer
- Quality Assurance Engineer
- API Integration Engineer
- Technical Product Manager

Your assignment is to design, extract, develop, integrate, test and package ELESEND as a completely independent delivery technology platform.

You are responsible for the technical quality, architecture, security, implementation and verification of the system.

Do not merely produce a theoretical proposal.

Inspect the provided source code, implement the necessary systems, run executable tests where possible, fix demonstrated defects and deliver a reproducible working project.

Never claim that code, functionality, security or integrations have been verified unless actual evidence supports the claim.

**The primary objective is to transform reusable delivery technology from ELEMARKET into an independent logistics marketplace without destabilizing ELEMARKET.**

---

# 2. FUNDAMENTAL BUSINESS REQUIREMENT

ELESEND is a standalone delivery platform.

It is NOT an ELEMARKET feature.

It is NOT an ELEMARKET rider dashboard.

It is NOT an internal marketplace delivery module.

It must function as an independent delivery business, comparable in participation model to on-demand courier and delivery platforms.

ELESEND connects:

1. Individuals requesting delivery services.
2. Businesses requesting delivery services.
3. Independent riders and drivers.
4. Registered logistics companies.
5. Riders employed by logistics companies.
6. External business platforms integrating through APIs.

ELESEND generates revenue from delivery transactions and other approved logistics services.

ELEMARKET may use ELESEND as an external logistics provider, but the two applications must remain operationally and technically independent.

### Non-negotiable independence requirements

ELESEND must have:

- Its own backend.
- Its own database.
- Its own authentication system.
- Its own customers.
- Its own riders.
- Its own logistics companies.
- Its own administration.
- Its own shipment management.
- Its own dispatch engine.
- Its own payments integration.
- Its own commission and earnings engine.
- Its own public and business APIs.
- Its own deployment pipeline.
- Its own application branding.

An ELEMARKET outage must not prevent ELESEND customers from independently booking and completing deliveries.

Do not establish direct database dependencies between these platforms.

---

# 3. PHASE ONE — DEEP ELEMARKET SOURCE AUDIT

Extract and inspect the latest supplied ELEMARKET source archive.

First:

1. Identify the archive version.
2. Calculate its SHA-256 checksum.
3. Inspect project architecture.
4. Identify programming languages and frameworks.
5. Enumerate delivery modules.
6. Inspect delivery database schemas.
7. Inspect delivery migrations.
8. Analyze provider interfaces and registries.
9. Inspect rider authentication and authorization.
10. Inspect delivery verification and OTP functionality.
11. Review delivery event processing.
12. Inspect delivery payment and settlement dependencies.
13. Review all delivery-related tests.

Identify reusable components, including:

- Delivery orchestration.
- Delivery provider management.
- Delivery assignment.
- Rider management.
- Delivery OTP verification.
- Shipment status handling.
- Pickup confirmation.
- Mapping and geolocation.
- Provider-neutral adapters.
- Delivery event processing.
- Webhook authentication.
- Audit logging.
- Delivery disputes.
- Administrative permissions.

For each component, establish:

- Its source location.
- Its dependencies.
- Its operational readiness.
- Its security weaknesses.
- Its relationship to marketplace-specific entities.
- Whether it can be extracted safely.
- Whether adaptation or replacement is required.

Produce a detailed dependency map.

### Critical preservation requirement

Do not delete or relocate code from ELEMARKET.

Initially, extract copies into a new ELESEND repository.

Do not change ELEMARKET's existing delivery interfaces, authentication, migrations, checkout, payments or order protection workflows.

Never assume an existing component is secure merely because it exists.

If a component is defective, document and remediate the defect in ELESEND before relying on it.

---

# 4. PHASE TWO — ESTABLISH INDEPENDENT ELESEND ARCHITECTURE

Create a dedicated application repository named:

`elesend`

Use an organized modular architecture.

The initial backend should preferably retain TypeScript and Node.js when technically justified by the existing ELEMARKET implementation.

Use PostgreSQL for persistent storage.

Use Redis or another justified mechanism for distributed coordination, queues, caching and time-limited operational data where necessary.

Preserve the ability to migrate between infrastructure providers.

Avoid unnecessary microservices and Kubernetes.

A properly structured modular monolith is acceptable and preferred for the initial release.

### Proposed architecture

```text
ELESEND PLATFORM
|
|-- Identity & Authentication
|-- Customer Accounts
|-- Business Accounts
|-- Rider Registration
|-- Rider Verification
|-- Logistics Company Registration
|-- Logistics Company Management
|-- Vehicle Management
|-- Shipment Booking
|-- Delivery Quotation
|-- Pricing Engine
|-- Dispatch Engine
|-- Rider Assignment
|-- Rider Availability
|-- Live Location Tracking
|-- Pickup Verification
|-- Delivery Verification
|-- Shipment Lifecycle
|-- Notifications
|-- Payment Integrations
|-- Commission Engine
|-- Rider Earnings
|-- Provider Settlements
|-- Refund Coordination
|-- Delivery Disputes
|-- Customer Support
|-- Ratings & Reviews
|-- Business Integration API
|-- Administrative Governance
|-- Audit & Security
|-- Analytics & Reporting
|
|-- PostgreSQL
|-- Redis / Queue Infrastructure
|-- Provider Adapter Registry
|-- External Integration Gateway
```

Every module must have clearly defined responsibilities.

Prevent circular dependencies.

Enforce authorization and business policy on the server.

Keep business logic separate from infrastructure adapters.

---

# 5. ELESEND APPLICATION ECOSYSTEM

Develop the following interfaces.

## APPLICATION A — ELESEND CUSTOMER

This application allows anyone to request a delivery.

Core features:

- Account registration.
- Secure login.
- Ghana-compatible phone verification.
- Sender profile.
- Saved addresses.
- Pickup location selection.
- Destination selection.
- Recipient details.
- Parcel description.
- Parcel category.
- Parcel weight.
- Parcel dimensions.
- Declared parcel value.
- Delivery price quotation.
- Delivery speed selection.
- Delivery booking.
- Payment.
- Live shipment tracking.
- Rider information.
- Estimated arrival time.
- Delivery notifications.
- Delivery history.
- Electronic receipts.
- Delivery cancellation.
- Failed-delivery support.
- Customer complaints.
- Delivery ratings.

Customers must be able to request deliveries without purchasing anything from ELEMARKET.

### Example

A customer in Cape Coast wants to send a mobile phone to someone in Accra.

The customer opens ELESEND, enters the shipment information, obtains a quotation, confirms payment and requests a delivery.

An eligible rider or logistics company handles the shipment.

All activities occur within ELESEND.

No ELEMARKET account is involved.

---

# 6. APPLICATION B — ELESEND RIDER APP

Develop a dedicated mobile-first rider experience.

The application must support two rider categories:

**Category A: Independent Riders**

Individuals registering directly with ELESEND to earn money from deliveries.

**Category B: Company Riders**

Riders operating under registered logistics companies.

Both categories use the ELESEND Rider App.

However, the system must enforce distinct ownership, assignment, settlement and authorization policies.

## Rider registration

Collect the following information where necessary and lawful:

- Full name.
- Phone number.
- Email address when available.
- Identity verification information.
- Profile photograph.
- Ghana Card verification details.
- Residential or operational region.
- Vehicle category.
- Vehicle registration information.
- Driving licence where applicable.
- Required vehicle documentation.
- Payout account.
- Emergency contact.
- Acceptance of rider terms.

The system must support manual administrator verification when automated identity verification is unavailable.

Manual approval must be permission-controlled and fully audited.

A rider must not receive active delivery assignments before completing the required approval process.

## Supported vehicles

Design a configurable vehicle registry supporting:

- Bicycle.
- Motorcycle.
- Tricycle.
- Car.
- Pickup truck.
- Van.
- Truck.
- Additional vehicle categories.

Vehicle suitability must influence delivery assignments.

A motorcycle rider should not be assigned a parcel exceeding the applicable weight or size limits.

## Rider home dashboard

Display:

- Online/offline status.
- Current availability.
- New delivery offers.
- Active deliveries.
- Pickup location.
- Destination location.
- Estimated delivery payment.
- Completed deliveries.
- Daily earnings.
- Weekly earnings.
- Pending earnings.
- Payment history.
- Rider rating.
- Support notifications.

## Delivery acceptance

When a suitable delivery becomes available:

1. Notify eligible riders.
2. Display relevant job information.
3. Display proposed rider compensation.
4. Allow acceptance within a configurable period.
5. Atomically reserve the assignment.
6. Prevent duplicate rider assignment.
7. Confirm the successful assignment.
8. Notify the sender and relevant parties.

Use database transactions and concurrency controls.

A delivery must never become simultaneously owned by two independent riders through racing acceptance requests.

## Navigation

Support:

- Navigation to merchant or sender.
- Navigation to recipient.
- Estimated distance.
- Estimated travel time.
- Location updates.
- Route adjustments.
- Delivery progress.

Protect customer location privacy.

Only collect location data necessary for legitimate operations, with appropriate consent and permissions.

## Network reliability

The Rider App must handle unstable mobile internet connections.

Implement:

- Connection-state detection.
- Safe retries.
- Idempotent operations.
- Local caching of non-sensitive task information.
- Offline-safe display of previously assigned jobs.
- Explicit synchronization status.

Do not allow offline actions to falsely confirm delivery, payment or OTP verification.

The backend remains authoritative.

## Mobile deliverable

Provide an installable Android application when the build environment supports it.

Use a suitable maintainable mobile framework.

Evaluate React Native or Flutter based on technical fit, deployment requirements and project maintenance costs.

If a native build cannot be completed, provide the complete application source, reproducible build instructions and clear evidence of what remains unverified.

Do not misrepresent a PWA as a tested native Android application.

---

# 7. APPLICATION C — LOGISTICS COMPANY DASHBOARD

Allow registered logistics companies to join ELESEND independently.

## Company registration

Support:

- Registered business name.
- Business registration details.
- Business contact information.
- Company administrator.
- Operating address.
- Service regions.
- Vehicle categories.
- Fleet capacity.
- Applicable supporting documents.
- Settlement information.
- Platform terms acceptance.

Administrative verification must support both automated evidence checks and controlled manual review.

## Fleet management

Companies must be able to:

- Create rider profiles.
- Invite existing approved riders.
- Assign riders to the company.
- Remove rider affiliations through controlled procedures.
- Register vehicles.
- Manage vehicle availability.
- Define delivery service areas.
- Manage operating hours.
- Review active assignments.
- Reassign deliveries where policy permits.
- Track company rider performance.
- Review delivery earnings.
- Investigate incidents.
- Access shipment history.

Company riders must not automatically become independent riders.

A rider's employer or platform affiliation must be explicit.

Prevent conflicting assignments and unauthorized simultaneous company affiliations.

## Tenant isolation

A logistics company must never access:

- Another company's riders.
- Another company's settlement records.
- Another company's private shipments.
- Another company's operational data.

Enforce isolation at the backend and database-query levels.

Do not rely on frontend restrictions.

---

# 8. APPLICATION D — ELESEND BUSINESS DASHBOARD

Develop a separate business customer interface.

This is different from the logistics company dashboard.

Businesses using ELESEND to send packages should be able to:

- Register business accounts.
- Manage business staff.
- Create individual shipments.
- Upload bulk shipment requests.
- Schedule pickups.
- Track multiple deliveries.
- Manage recipient addresses.
- Review delivery expenditure.
- Download invoices.
- View delivery performance.
- Create API credentials.
- Configure webhook endpoints.
- Access integration documentation.

Support configurable business pricing and contractual terms.

Bulk bookings must enforce validation and reasonable request limits.

Do not allow one business to view another business's customers or shipment information.

---

# 9. APPLICATION E — ELESEND ADMINISTRATION

Create an independent ELESEND management dashboard.

It must not depend on ELEMARKET's administration portal.

## Administrative capabilities

Authorized administrators can:

- Approve independent riders.
- Reject applications.
- Suspend riders.
- Approve logistics companies.
- Suspend logistics companies.
- Review verification documents.
- Manage customer accounts.
- Configure operating regions.
- Configure vehicle categories.
- Configure delivery pricing.
- Configure platform commissions.
- Configure service availability.
- Manage dispatch policies.
- Monitor active deliveries.
- Investigate disputes.
- Manage customer support.
- Review payment records.
- Review commission records.
- Manage payout eligibility.
- Configure integration providers.
- Manage business API clients.
- View performance analytics.
- Review security events.

## Enterprise-grade role governance

Do not restrict administration to fixed roles such as Owner, Support and Operations.

Authorized top-level administrators must be able to create additional company roles and assign granular permissions.

Examples include:

- Operations Manager.
- Regional Manager.
- Fleet Supervisor.
- Rider Verification Officer.
- Customer Support Officer.
- Finance Officer.
- Risk Officer.
- Human Resources Officer.
- Compliance Officer.

Sensitive actions must have audit records.

High-risk financial or administrative operations should support additional authorization controls.

---

# 10. DELIVERY BOOKING ENGINE

Build a standalone shipment domain.

Do not require an ELEMARKET order identifier to create a shipment.

Every shipment must have its own unique identifier.

## Required shipment information

- Shipment identifier.
- Sender identifier.
- Recipient information.
- Pickup address.
- Delivery address.
- Pickup coordinates.
- Delivery coordinates.
- Parcel category.
- Parcel description.
- Declared weight.
- Declared dimensions.
- Declared value, where applicable.
- Requested delivery service.
- Calculated delivery price.
- Payment status.
- Assignment status.
- Assigned delivery personnel.
- Delivery timestamps.
- Verification references.
- Shipment events.
- Cancellation information.
- Dispute status.

## Shipment state machine

Define strict transitions covering:

```text
DRAFT
  |
QUOTED
  |
BOOKING CONFIRMED
  |
AWAITING PAYMENT
  |
PAYMENT CONFIRMED
  |
AWAITING ASSIGNMENT
  |
RIDER ASSIGNED
  |
RIDER ARRIVING AT PICKUP
  |
PICKUP VERIFIED
  |
IN TRANSIT
  |
ARRIVING AT DESTINATION
  |
AWAITING DELIVERY OTP
  |
DELIVERY VERIFIED
  |
COMPLETED
```

Include appropriate alternate paths for:

- Booking cancellation.
- Payment failure.
- Rider rejection.
- Reassignment.
- Pickup failure.
- Failed delivery attempt.
- Customer unavailable.
- Incorrect address.
- Recipient refusal.
- Lost parcel.
- Damaged parcel.
- Return to sender.
- Refund requested.
- Dispute opened.

The implementation must model these as controlled transitions, not unrestricted changes to status strings.

A paid shipment must not become completed without valid delivery verification.

---

# 11. DELIVERY DISPATCH ENGINE

This is one of ELESEND's most important systems.

Build a configurable dispatch and matching engine.

Its purpose is to connect delivery requests with eligible independent riders and logistics companies.

## Dispatch inputs

Evaluate:

- Rider location.
- Distance from pickup.
- Vehicle suitability.
- Parcel dimensions.
- Parcel weight.
- Rider availability.
- Rider verification status.
- Rider workload.
- Delivery coverage.
- Service operating hours.
- Delivery urgency.
- Provider eligibility.
- Estimated cost.
- Applicable contractual policies.

Build a transparent eligibility and ranking mechanism.

Do not hardcode individual riders or logistics companies into the dispatch logic.

## Dispatch modes

Support:

**Automatic Dispatch**

The system identifies and offers assignments to eligible riders.

**Company Dispatch**

An approved logistics provider assigns jobs to authorized company riders.

**Controlled Manual Dispatch**

Authorized ELESEND operations staff can intervene when automatic dispatch is unsuccessful.

Manual intervention must be audited.

## Concurrency

Prevent:

- Duplicate assignments.
- Reassignment of completed shipments.
- Acceptance by suspended riders.
- Acceptance outside authorized service areas.
- Expired job acceptance.
- Duplicate pickup confirmation.
- Duplicate completion.
- Financial duplication caused by retries.

Use transactions, idempotency keys and explicit locking or equivalent concurrency strategies.

---

# 12. PICKUP VERIFICATION

Develop secure parcel collection verification.

A delivery should not enter the in-transit state solely because a rider presses a button.

Implement sender-to-rider custody handover verification.

Support an appropriate authenticated pickup mechanism, such as:

- Short-lived sender pickup OTP.
- Secure QR code.
- Controlled business pickup confirmation.

The actual assigned rider must perform the pickup action.

Record:

- Rider identity.
- Shipment identity.
- Pickup timestamp.
- Authorized pickup result.
- Relevant location information.
- Applicable parcel condition evidence.

Protect uploaded evidence against unauthorized access.

Store sensitive evidence only for defined operational needs.

Use retention and deletion policies.

Do not treat images alone as conclusive proof of authorized handover.

---

# 13. MANDATORY DELIVERY OTP

Delivery verification is a critical security requirement.

All normal successful ELESEND deliveries must require authenticated recipient verification.

The OTP must be initiated by the actual assigned rider during handover.

Never automatically issue the OTP merely because a shipment reaches a particular delivery status.

Do not allow general administrators or logistics company operators to impersonate the rider.

## Required workflow

1. The assigned rider arrives at the destination.
2. The rider opens the active shipment.
3. The rider selects Request Delivery OTP.
4. The backend authenticates and authorizes the rider.
5. The system confirms the active shipment assignment.
6. The system generates a short-lived OTP.
7. The OTP is sent to the locked recipient phone number.
8. The recipient communicates the OTP to the rider.
9. The rider submits the OTP.
10. The backend validates it.
11. Successful verification records the handover.
12. The shipment transitions atomically to verified delivery.
13. Completion and downstream financial events are triggered idempotently.

Enforce:

- OTP expiration.
- Attempt limits.
- Rate limiting.
- Secure OTP storage.
- Replay prevention.
- Rider-job binding.
- Recipient binding.
- Delivery-state validation.
- Detailed audit logging.
- Race-condition protection.

No successful OTP verification means no ordinary successful delivery confirmation.

Implement controlled exception and incident workflows without silently bypassing the security model.

For company riders, the rider identity must be verified independently of the company administrator.

---

# 14. DELIVERY PRICING ENGINE

Build a configurable pricing system.

Support pricing inputs such as:

- Distance.
- Delivery region.
- Vehicle category.
- Parcel size.
- Parcel weight.
- Service urgency.
- Delivery type.
- Applicable provider rates.
- Operating conditions.
- Contractual business discounts.

Avoid permanently hardcoded delivery prices.

Administrators must be able to configure pricing policies.

The system must produce transparent quotations.

## Illustrative example

Customer delivery charge: GH₵40.00

Rider or provider gross allocation: GH₵34.00

ELESEND gross commission: GH₵6.00

These values are examples only.

Do not hardcode a 15% commission.

Commission policies must be configurable and versioned.

Quoted amounts must remain consistent with the confirmed booking terms.

Do not silently recalculate a customer's accepted quote.

---

# 15. COMMISSION AND REVENUE ENGINE

ELESEND is a commercial logistics platform.

It must generate measurable revenue from delivery transactions.

## Revenue categories

Support:

1. Independent rider delivery commissions.
2. Logistics company delivery commissions.
3. Business delivery service fees.
4. Contractual enterprise delivery charges.
5. Premium express delivery fees.
6. Approved integration or subscription charges.

Implement an accurate financial accounting layer.

For each completed transaction, record:

- Customer charge.
- Tax components where applicable.
- Payment processing cost.
- Rider or company entitlement.
- ELESEND gross commission.
- Adjustments.
- Refunds.
- Payout status.
- Platform net revenue calculations.

All financial amounts must use exact decimal or integer minor-unit representations.

Do not use floating-point arithmetic for monetary accounting.

Use immutable financial events or equivalent auditable posting records.

Prevent duplicate commissions and payouts.

## Independent riders

Support earnings records and payout requests or provider-managed payout workflows.

## Logistics companies

Support separate company settlement accounts and contractual commission rules.

## Payment architecture

Do not create an unlicensed custodial wallet or internally hold customer funds merely because the application needs rider earnings tracking.

Use suitable regulated payment partners and supported settlement arrangements.

Financial ledgers should record obligations and transactions without falsely representing internally controlled customer funds.

Payment collection, refunds and payouts must use provider-neutral adapters.

Reconcile financial records against actual provider events.

Do not equate a displayed earnings balance with settled cash.

---

# 16. PAYMENT INTEGRATION

Implement a generic payment provider interface.

The system must be capable of supporting:

- Ghana mobile money.
- Bank-supported payments.
- Cards.
- Business invoicing.
- Approved payment links.
- Provider-managed refunds.
- Provider-supported disbursements.

Provider-specific code must exist only within isolated adapters.

Never embed replaceable provider names inside core financial domain logic.

Where the required credentials are available, use real provider test environments.

Never claim a payment succeeded because a mocked response returned success.

Webhook handling must include:

- Signature verification.
- Replay protection.
- Idempotency.
- Transaction reconciliation.
- Event validation.
- Error handling.
- Retry policies.
- Dead-letter handling where appropriate.

Do not release real-money functionality until integration tests and financial reconciliation controls have been verified.

Do not store full card credentials.

---

# 17. LIVE TRACKING AND GEOLOCATION

Build ELESEND's independent location services.

The system should support:

- Rider proximity.
- Pickup distance.
- Delivery distance.
- ETA calculation.
- Active shipment location.
- Service coverage.
- Delivery route information.
- Last known rider location.

Use a provider-neutral geolocation interface.

Geoapify may be implemented as an initial adapter where technically suitable.

Do not hardcode Geoapify into domain logic.

Support different mapping providers through configuration and adapters.

## Privacy and security

- Require appropriate location permissions.
- Track location only for justified operational purposes.
- Restrict customer access to their own shipment tracking.
- Prevent unrelated users from accessing a rider's location.
- Limit precision when exact coordinates are unnecessary.
- Avoid unlimited location-history retention.
- Validate location updates against active assignments.

Recognize that GPS coordinates can be spoofed.

Location alone must never establish successful delivery.

---

# 18. EXTERNAL DELIVERIES

ELESEND must support deliveries originating outside ELEMARKET.

This is a fundamental business requirement.

## Supported booking sources

1. ELESEND Customer App.
2. ELESEND Business Dashboard.
3. ELESEND administrative booking.
4. External e-commerce websites.
5. Third-party business applications.
6. Authorized integration partners.

Every booking source must use the same core shipment and security policies.

Do not create separate inconsistent dispatch engines for different booking channels.

## Business delivery example

A clothing store operating outside ELEMARKET receives a customer order.

The business opens ELESEND and requests pickup and delivery.

An independent ELESEND rider accepts the assignment.

The parcel is collected and delivered.

The recipient confirms delivery through OTP.

The business receives confirmation.

ELESEND records its earned commission.

The clothing store does not need an ELEMARKET account.

---

# 19. PUBLIC BUSINESS API

Develop a secure API allowing third-party businesses to integrate ELESEND directly.

Suggested capabilities include:

```text
POST /api/v1/quotes

POST /api/v1/shipments

GET /api/v1/shipments/{id}

POST /api/v1/shipments/{id}/cancel

GET /api/v1/shipments/{id}/tracking

GET /api/v1/business/shipments

GET /api/v1/business/transactions
```

These endpoints are illustrative and should be refined according to the final architecture.

Implement:

- API authentication.
- Scoped credentials.
- API key rotation.
- Rate limiting.
- Idempotency.
- Request validation.
- Tenant isolation.
- Webhook registration.
- Signed outbound webhooks.
- Retry handling.
- API versioning.
- Developer documentation.

Business API clients must never gain rider-administration or platform-administration permissions.

---

# 20. ELEMARKET INTEGRATION

ELEMARKET may become an ELESEND delivery customer.

However:

**ELEMARKET and ELESEND must remain independent platforms.**

Create a provider-neutral integration adapter.

Do not make ELESEND part of ELEMARKET's core order-processing module.

## Integration workflow

1. Customer places an order on ELEMARKET.
2. ELEMARKET obtains eligible delivery quotations.
3. ELESEND returns a quotation through its API.
4. ELEMARKET selects an authorized delivery provider.
5. If ELESEND is selected, ELEMARKET requests shipment creation.
6. ELESEND creates an independent shipment record.
7. ELESEND assigns an authorized delivery rider.
8. Rider collects the parcel.
9. ELESEND sends signed shipment progress events.
10. ELEMARKET updates authorized delivery status.

### Mandatory ELEMARKET OTP compatibility

ELEMARKET already has a specific delivery security policy:

- Every marketplace order requires rider-triggered delivery OTP.
- The actual assigned rider initiates OTP.
- The OTP is delivered to the marketplace order's locked customer phone.
- The rider submits the customer's OTP.
- Successful verification confirms receipt.
- ELEMARKET starts its 24-hour post-receipt protection period.

Preserve this policy.

For ELEMARKET-originated shipments, ELEMARKET must retain authority over its customer OTP and order confirmation.

Use an authenticated cross-platform verification contract binding:

- ELEMARKET order.
- ELESEND shipment.
- Actual assigned rider.
- Recipient.
- Verification challenge.
- Verified completion event.

ELESEND must not independently override ELEMARKET's protected order state.

ELESEND may reflect completed delivery only after receiving the authoritative verification result.

Use secure signed events, idempotent retries and fail-closed behavior.

Do not let ordinary delivery webhooks bypass customer verification.

## Integration independence

Do not:

- Share database tables.
- Share authentication sessions.
- Hardcode ELESEND into marketplace business logic.
- Automatically prefer ELESEND over other delivery providers.
- Require ELESEND to access internal ELEMARKET databases.
- Allow ELESEND to modify marketplace financial records directly.

Provide the integration as a separate, reviewable adapter package or patch.

Do not modify the original ELEMARKET release candidate unless explicitly instructed to apply the integration.

---

# 21. NOTIFICATION SYSTEM

ELESEND requires a reliable notification framework.

Support appropriate channels such as:

- Mobile push notifications.
- SMS.
- Email.
- In-app notifications.

Notify customers about:

- Booking confirmation.
- Payment confirmation.
- Rider assignment.
- Rider arrival.
- Parcel pickup.
- Delivery progress.
- Delivery OTP.
- Successful completion.
- Delivery failure.
- Refund outcomes.

Notify riders about:

- New delivery offers.
- Assignment confirmations.
- Cancellations.
- Reassignments.
- Payment status changes.
- Administrative account restrictions.

Use configurable provider adapters.

Do not hardcode messaging vendors into business workflows.

Never expose OTP values in application logs, analytics or administrative dashboards.

---

# 22. SUPPORT AND DISPUTE MANAGEMENT

Create a centralized support system.

Support incidents such as:

- Missing parcels.
- Damaged goods.
- Customer unreachable.
- Wrong delivery address.
- Rider misconduct.
- Payment disputes.
- Failed pickup.
- Failed delivery.
- Unauthorized recipient.
- Lost shipment.
- Suspicious delivery activity.

Each incident should have:

- Incident identifier.
- Related shipment.
- Reporter.
- Assigned support personnel.
- Incident category.
- Evidence references.
- Investigation notes.
- Status.
- Resolution.
- Audit history.

Restrict access to evidence and customer personal information.

Provide clear customer compensation, claims and liability policies as configurable business rules.

Do not promise insurance coverage unless an actual insurance arrangement exists.

Do not automatically apply ELEMARKET's 24-hour marketplace protection policy to ELESEND's standalone parcel services.

---

# 23. SECURITY REQUIREMENTS

Treat ELESEND as a high-risk transactional platform because it handles money, personal identities, physical goods and real-world delivery personnel.

Apply secure engineering principles throughout.

## Identity and authorization

- Secure authentication.
- Strong session management.
- Server-side authorization.
- MFA for sensitive administrative roles.
- Scoped business API credentials.
- Tenant isolation.
- Rider-role isolation.
- Verified rider-to-shipment binding.
- Protection against account takeover.
- Secure password handling.

## API security

- Strict input validation.
- Rate limiting.
- Authorization checks.
- Request size limits.
- Secure pagination.
- API abuse prevention.
- SSRF protection.
- Safe webhook processing.
- Secure file uploads.
- Protection against injection attacks.

## Transaction security

- Idempotent booking creation.
- Concurrent assignment protection.
- OTP replay prevention.
- Secure payment confirmation.
- Financial event reconciliation.
- Atomic delivery confirmation.
- Duplicate settlement prevention.

## Infrastructure security

- Separate production and test credentials.
- Least-privilege database accounts.
- Secrets management.
- Encrypted transport.
- Secure backup procedures.
- Restricted administrative access.
- Centralized application logging.
- Security monitoring.
- Recovery procedures.

Use relevant OWASP guidance.

Conduct negative authorization tests, including attempts by one rider to access another rider's delivery and attempts by one logistics company to access another company's data.

Do not expose sensitive customer or rider identity documents through publicly accessible storage URLs.

---

# 24. GHANA MARKET REQUIREMENTS

Design the platform primarily for Ghana.

Support:

- Ghana cedi transactions.
- Ghana mobile money integrations.
- Ghana phone number formats, including valid local and +233 representations.
- Ghana regions and districts.
- Accra and other major cities.
- Regional delivery coverage.
- Low-bandwidth mobile connectivity.
- Android-first rider participation.
- Configurable local pricing.

Use Africa/Accra as the business-local timezone where relevant while storing appropriate canonical UTC timestamps.

Do not assume every location has a conventional street address.

Support usable pickup landmarks and geolocation information.

## Geographic expansion

The platform should eventually support:

- Intracity deliveries.
- Intercity deliveries.
- Regional courier services.
- Business logistics contracts.

However, do not enable complex intercity or high-risk delivery categories before operational rules, pricing, custody transfers and responsible providers have been established.

## Legal and operational safeguards

Identify relevant Ghanaian requirements affecting:

- Courier operations.
- Rider and vehicle eligibility.
- Business verification.
- Consumer protection.
- Data protection.
- Payment processing.
- Delivery liability.
- Restricted parcels.

Do not claim legal compliance without verifying the applicable requirements.

Separate implementation of compliance controls from confirmation of actual licensing or regulatory approval.

---

# 25. PROVIDER NEUTRALITY

This is a strict architectural requirement.

ELESEND must not become dependent on one external provider.

Apply provider neutrality to:

- Payment processing.
- Mobile money collections.
- Payouts.
- SMS.
- Email.
- Push notifications.
- Geolocation.
- Routing.
- Object storage.
- Hosting infrastructure.
- Analytics.
- Identity verification.
- Third-party logistics connections.

Provider-specific code belongs in adapters.

Domain policies must not assume a particular vendor.

Use registries, interfaces and configuration-driven selection.

Preserve the ability to replace providers without rewriting the shipment, dispatch or financial engines.

---

# 26. DATABASE DESIGN

Create ELESEND-specific database migrations.

Candidate domain entities include:

```text
users
customer_profiles
business_accounts
business_memberships
rider_profiles
rider_verifications
rider_affiliations
logistics_companies
company_memberships
vehicles
service_areas
delivery_quotes
shipments
shipment_parcels
shipment_assignments
shipment_events
pickup_verifications
delivery_verifications
rider_locations
pricing_policies
commission_policies
payments
payment_events
financial_entries
provider_earnings
payout_requests
payout_transactions
refunds
disputes
notifications
api_clients
webhook_subscriptions
webhook_deliveries
admin_roles
admin_permissions
audit_logs
```

Refine this model after source inspection.

Do not blindly create tables without evaluating normalization, relationships and operational requirements.

Ensure:

- Referential integrity.
- Appropriate uniqueness constraints.
- Tenant-safe queries.
- Financial precision.
- Secure identity-document references.
- Migration reversibility where appropriate.
- Appropriate indexes.
- Correct transaction boundaries.

Prevent circular schema dependencies and uncontrolled migration histories.

---

# 27. RELIABILITY AND PERFORMANCE

Design for gradual growth from a small Ghana pilot to significant national delivery volume.

Implement:

- Stateless application processes where practical.
- Durable event handling.
- Background job processing.
- Retry mechanisms.
- Dead-letter handling.
- Connection pooling.
- Database indexes.
- Controlled caching.
- Health checks.
- Structured logs.
- Operational metrics.
- Graceful shutdown.
- Error monitoring.
- Backup and recovery procedures.

Do not overengineer for millions of users before establishing actual demand.

However, avoid architectural limitations that would require rewriting the entire platform when delivery volumes grow.

---

# 28. DEPLOYMENT

Prepare ELESEND for affordable initial deployment.

The founder has limited infrastructure resources.

Prioritize operational efficiency.

Provide a reproducible Docker-based deployment.

Suitable initial architecture:

```text
VPS / CLOUD HOST
|
|-- Reverse Proxy
|
|-- ELESEND API
|
|-- Background Workers
|
|-- Customer Web App
|
|-- Business Dashboard
|
|-- Logistics Dashboard
|
|-- Admin Dashboard
|
|-- PostgreSQL
|
|-- Redis / Queue Infrastructure
|
|-- Monitoring & Logs
```

Use separate container services and appropriate network restrictions.

Do not expose PostgreSQL or Redis publicly.

Support environment-based configuration.

Prepare:

- Dockerfiles.
- Docker Compose configuration.
- Environment variable templates.
- Database migration commands.
- Health checks.
- Backup instructions.
- Production deployment documentation.
- CI configuration.
- Startup diagnostics.

Do not hardcode secrets.

Avoid unnecessary infrastructure expenses.

Build toward future cloud migration without introducing premature complexity.

---

# 29. FRONTEND AND USER EXPERIENCE

ELESEND should look and behave like a serious commercial logistics platform.

Avoid generic unfinished dashboards.

## Customer experience

Prioritize:

- Fast booking.
- Simple address selection.
- Transparent pricing.
- Clear payment confirmation.
- Shipment tracking.
- Trustworthy rider information.
- Visible customer support.

## Rider experience

Prioritize:

- Large, accessible controls.
- Fast job acceptance.
- Clear earnings.
- Low-data operation.
- Reliable navigation.
- Minimal distractions during transport.
- Strong delivery verification.
- Clear failure reporting.

## Company experience

Prioritize:

- Fleet visibility.
- Efficient dispatch.
- Rider activity.
- Shipment status.
- Financial reporting.
- Operational exceptions.

## Administrator experience

Prioritize:

- Delivery oversight.
- Fraud visibility.
- Approval workflows.
- Financial accountability.
- Security events.
- Delegated operational control.

Ensure responsive layouts and accessibility.

Avoid artificial statistics and fabricated customer reviews.

---

# 30. STRICT MVP PRIORITIES

The long-term architecture must support the full ELESEND vision.

However, the first release must prioritize a complete and reliable delivery transaction.

## Release-critical functionality

The initial operational MVP must include:

1. Independent ELESEND backend.
2. Independent PostgreSQL database.
3. Customer registration and login.
4. Individual rider onboarding and approval.
5. Logistics company onboarding and approval.
6. Company rider management.
7. Shipment quotation.
8. Shipment booking.
9. Payment confirmation through an actual test integration.
10. Delivery dispatch.
11. Rider acceptance.
12. Pickup verification.
13. Delivery tracking.
14. Rider-triggered recipient OTP.
15. Verified delivery completion.
16. Configurable delivery commission.
17. Accurate earnings records.
18. Provider-supported payout workflow or clearly controlled payout eligibility.
19. Administrative oversight.
20. Delivery failure handling.
21. Customer support and disputes.
22. Business shipment booking.
23. Secure external integration API.
24. Automated regression testing.
25. Reproducible deployment.

## Post-MVP capabilities

Prepare extensibility for:

- Advanced intercity routing.
- Multi-stop deliveries.
- Scheduled recurring business deliveries.
- Dynamic demand-based pricing.
- Advanced fleet optimization.
- Enterprise contracts.
- Sophisticated fraud scoring.
- Additional mobile platforms.
- Cross-border delivery corridors.

Do not let future features destabilize the initial delivery workflow.

---

# 31. TESTING AND QUALITY ASSURANCE

Testing must cover the full delivery lifecycle.

## Functional tests

Verify:

- Customer registration.
- Rider registration.
- Company registration.
- Manual approval.
- Booking.
- Quotation.
- Payment confirmation.
- Dispatch.
- Pickup.
- Delivery OTP.
- Completion.
- Commission calculation.
- Cancellation.
- Refund coordination.
- Dispute creation.

## Security tests

Verify:

- Unauthorized rider access is rejected.
- Suspended riders cannot receive assignments.
- Company A cannot access Company B.
- One customer cannot access another customer's shipment.
- OTP attempts are limited.
- Expired OTPs fail.
- Replayed OTPs fail.
- Incorrect rider verification fails.
- Forged webhook signatures fail.
- Duplicate payment events do not create duplicate earnings.
- Administrative privilege escalation is blocked.

## Concurrency tests

Simulate:

- Multiple riders accepting one job.
- Multiple OTP submissions.
- Concurrent delivery status updates.
- Repeated payment callbacks.
- Repeated webhook notifications.
- Rider cancellation during reassignment.
- Payout retries.
- Database transaction failures.

## Integration tests

Use real PostgreSQL.

Use actual migrations.

Use provider sandbox environments when credentials are available.

Test the complete independent journey:

```text
Register Customer
       ↓
Create Shipment
       ↓
Calculate Quote
       ↓
Confirm Payment
       ↓
Assign Rider
       ↓
Verify Pickup
       ↓
Track Delivery
       ↓
Trigger OTP
       ↓
Verify Recipient
       ↓
Complete Shipment
       ↓
Record Commission
       ↓
Record Rider Earnings
```

Do not substitute mocks for all real integration tests.

Mocks are permitted for isolated unit tests, but must not be presented as proof of real payment or delivery-provider integration.

## Performance tests

Measure realistic workloads.

Evaluate:

- Booking response times.
- Concurrent dispatch requests.
- Database contention.
- Location-update throughput.
- Webhook processing.
- Worker reliability.
- Queue recovery.

Do not claim a particular scalability capacity without test evidence.

---

# 32. PRESERVE ELEMARKET

ELESEND development must not damage the existing ELEMARKET application.

This requirement is critical.

Before modifying any shared material:

1. Preserve the original source.
2. Establish a clean baseline.
3. Record archive checksum.
4. Document reusable components.
5. Extract copies into ELESEND.
6. Remove marketplace-specific dependencies.
7. Run independent tests.
8. Verify the original ELEMARKET source remains unchanged.

Produce an optional ELEMARKET integration adapter separately.

Do not migrate ELEMARKET's existing delivery tables into ELESEND.

Do not delete marketplace delivery functionality.

Do not replace ELEMARKET's existing provider registry.

Do not create hard dependencies on ELESEND.

The existing ELEMARKET deployment must remain valid.

---

# 33. ENGINEERING DOCUMENTATION

Produce accurate technical documentation.

Include:

**A. Source Audit Report**

Existing ELEMARKET delivery components and extraction decisions.

**B. Extraction Dependency Matrix**

Reusable, adaptable and unsuitable modules.

**C. Architecture Documentation**

Standalone ELESEND backend and application topology.

**D. Database Documentation**

Entities, relationships, indexes and migrations.

**E. API Documentation**

Customer, rider, company, administrator and external business interfaces.

**F. Dispatch Documentation**

Assignment algorithms, eligibility and concurrency controls.

**G. OTP Security Documentation**

Pickup and recipient verification, state transitions and anti-fraud controls.

**H. Financial Documentation**

Pricing, commissions, earnings, payout integration and reconciliation.

**I. Integration Documentation**

How ELESEND securely integrates with ELEMARKET without becoming dependent on it.

**J. Deployment Guide**

Local development, Docker, VPS and production configuration.

**K. Security Assessment**

Verified security controls, unresolved risks and their severity.

**L. Test Evidence**

Actual commands, results, failures and relevant logs.

---

# 34. FINAL DELIVERABLES

Do not stop after generating an architecture document.

Deliver the actual project source.

Package the results as:

`ELESEND_STANDALONE_LOGISTICS_PLATFORM.zip`

The archive should contain, where implemented:

```text
ELESEND/
|
|-- apps/
|   |-- customer/
|   |-- rider/
|   |-- business/
|   |-- logistics-provider/
|   |-- admin/
|
|-- services/
|   |-- api/
|   |-- worker/
|
|-- packages/
|   |-- contracts/
|   |-- shared/
|   |-- provider-adapters/
|
|-- database/
|   |-- migrations/
|
|-- integrations/
|   |-- elemarket-adapter/
|
|-- infrastructure/
|   |-- docker/
|
|-- tests/
|
|-- documentation/
|
|-- .env.example
|-- README.md
|-- package manifests
|-- deployment configuration
|-- test-results.md
|-- security-report.md
|-- release-readiness.md
```

Adapt the directory structure where justified by the selected frameworks.

Do not fabricate empty placeholder applications and describe them as completed systems.

All included implementation claims must correspond to actual working source.

Exclude production secrets, real identity documents and sensitive customer data.

Calculate the final archive SHA-256.

---

# 35. RELEASE ACCEPTANCE CRITERIA

ELESEND may be considered technically ready for controlled operational testing only when the release-critical requirements have been verified.

The final report must distinguish:

**PASS**

Implemented and successfully tested.

**PARTIAL**

Implemented with remaining limitations.

**BLOCKED**

Requires unavailable infrastructure, credentials, operational arrangements or external approval.

**FAIL**

Implemented but fails required verification.

**NOT IMPLEMENTED**

Not yet developed.

Do not use a general statement such as "production-ready" to hide untested functions.

A public real-money launch requires verified payment handling, financial reconciliation, critical delivery security, operational support procedures and applicable legal requirements.

If the environment prevents completion of a test, document the limitation instead of inventing a successful result.

Do not weaken OTP, authorization, financial controls or audit requirements merely to make tests pass.

---

# 36. EXECUTION STRATEGY

Execute the project systematically.

### Stage 1 — Discovery

Audit the actual ELEMARKET source and determine extraction feasibility.

### Stage 2 — Independence

Create ELESEND's independent project, database, authentication and foundational modules.

### Stage 3 — Core Logistics

Implement standalone booking, pricing, dispatch, shipment management and tracking.

### Stage 4 — Rider Network

Implement independent riders, company riders, registration, verification, availability and assignments.

### Stage 5 — Delivery Security

Implement pickup verification, mandatory delivery OTP, strict shipment transitions and fraud controls.

### Stage 6 — Commercial Operations

Implement payment integration, commissions, earnings, financial reconciliation and provider-supported settlements.

### Stage 7 — Applications

Implement the customer, rider, logistics company, business and administrator interfaces.

### Stage 8 — External Integration

Implement the public business API and optional ELEMARKET delivery adapter.

### Stage 9 — Verification

Execute functional, database, integration, security, concurrency and deployment testing.

### Stage 10 — Packaging

Deliver the standalone project archive, test evidence, deployment documentation and release assessment.

Fix demonstrated defects before moving forward wherever feasible.

Maintain a clear record of unresolved issues.

Do not silently downgrade project requirements when encountering implementation difficulties.

---

# 37. CRITICAL PROHIBITIONS

You must NOT:

1. Turn ELESEND into an ELEMARKET submodule.
2. Require ELEMARKET authentication.
3. Require an ELEMARKET marketplace order.
4. Share ELEMARKET's operational database.
5. Delete existing ELEMARKET delivery features.
6. Hardcode replaceable external providers into domain logic.
7. Allow unverified riders to receive jobs.
8. Allow unauthorized delivery completion.
9. Allow administrators to bypass normal rider OTP confirmation.
10. Trust GPS location as proof of delivery.
11. Permit duplicate rider assignments.
12. Permit duplicate payment or payout processing.
13. Mix customer funds with platform revenue without a lawful settlement arrangement.
14. Expose customer identity documents or private delivery information.
15. Misrepresent mock tests as live integrations.
16. Invent successful test results.
17. Add unnecessary microservices merely for architectural appearance.
18. Replace ELEMARKET's existing security mechanisms.
19. Change ELEMARKET's protected order-confirmation policy.
20. Claim regulatory approval or operational licensing that has not been obtained.

---

# 38. FINAL CTO MISSION

The objective is to create a serious independent logistics platform that can begin with a limited number of riders in Ghana and expand into a nationwide delivery network.

ELESEND must be capable of serving:

- Ordinary individuals.
- Independent riders.
- Motorcycle couriers.
- Car and van delivery drivers.
- Logistics companies.
- Retail businesses.
- E-commerce merchants.
- Online stores.
- Corporate delivery customers.
- Third-party platforms.

ELESEND must support its own customer acquisition, delivery operations and revenue generation.

It must not need ELEMARKET to function.

ELEMARKET should remain only one possible external customer or integration partner.

The architecture should permit future expansion into additional cities, larger fleets and new delivery categories without requiring a complete platform rewrite.

**PRIMARY ENGINEERING PRINCIPLE:**

Build one reliable, independent logistics platform with multiple customer, rider and provider interfaces, using carefully extracted and hardened ELEMARKET technology wherever appropriate.

**PRIMARY BUSINESS PRINCIPLE:**

Enable ELESEND to earn sustainable revenue by connecting delivery demand with independent riders and logistics businesses.

**PRIMARY SECURITY PRINCIPLE:**

No delivery should be falsely completed, no financial transaction should be duplicated, and no user should access another user's protected information.

**PRIMARY DELIVERY REQUIREMENT:**

Provide working, tested, maintainable source code—not just architectural descriptions.

Begin by inspecting the actual ELEMARKET source archive, establishing the extraction baseline and executing the implementation phases.

Continue through the executable work permitted by the environment, report blockers precisely, and produce the strongest verifiable standalone ELESEND release possible.

**ELESEND MUST BE INDEPENDENT. ELEMARKET MUST REMAIN STABLE. BOTH MUST BE ABLE TO OPERATE SEPARATELY.**