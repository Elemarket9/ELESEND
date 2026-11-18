# Cargo delivery launch notes

ELESEND cargo hire covers a cargo tricycle, pickup, van, box truck and long vehicle, as well as the existing motorcycle and car services. Vehicle limits are enforced from `vehicle_capabilities`; staff can change weight, trip distance, load length, volume, licence class, category, and launch status through `POST /api/v1/admin/vehicle-policy`.

## Safe activation

The box truck and long vehicle are disabled after migration. Van is also disabled. Staff should enable each class only after its approved vehicle records, licence class, routing profile, and real tariff are configured. Prices are integer pesewas. Do not enable a class while its active price is marked as a placeholder.

| Class | Weight | Maximum trip | Initial status |
|---|---:|---:|---|
| Tricycle | 300 kg | 25 km | Existing launch policy |
| Pickup | 1,000 kg | 300 km | Existing launch policy |
| Van | 1,500 kg | 400 km | Disabled |
| Box truck | 7,000 kg | 600 km | Disabled |
| Long vehicle | 30,000 kg | 800 km | Disabled |

No class-specific length or volume values were supplied for most vehicles, so those values remain unset instead of being guessed. Staff must enter fleet-verified length and volume limits before a cargo class accepts quotes. The long vehicle length ceiling starts at 16 m, the upper end of the requested 9–16 m range; its volume still needs a staff value.

## Driver licence classes

Do not treat older A–F summaries as current. Ghana's Road Traffic Regulations, 2026 (L.I. 2519), which took effect on 28 May 2026, use a revised scheme with subcategories, including hiring vehicles, goods vehicles, and articulated vehicles. The exact licence class required depends on the vehicle's licensed class and gross vehicle weight, not just the cargo payload. The minimum class therefore stays staff-editable and is not populated with a guessed universal value.

Before enabling a class, staff must confirm the current class/subcategory against the vehicle's DVLA record and the driver's licence, then set `minLicenceClass`. The dispatch gate checks that the rider's approved, unexpired licence class matches the configured class. If a class is not clear from the official records, keep it disabled and refer it to DVLA.

Sources:

- [DVLA Ghana: 2026 Mid-Year Review](https://www.dvla.gov.gh/news/101), describing L.I. 2519 and its effective date.
- [DVLA Ghana: Application for a Driver's Licence](https://www.dvla.gov.gh/services), current licensing procedures.
- [Ghana Ministry of Transport: 2026 road traffic regulations sensitisation](https://www.mot.gov.gh/10/16/1/365/transport-minister-launches-nationwide-sensitisation-on-the-new-road-traffic-laws-and-regulations), describing the new framework and commercial vehicle requirements.

## Vehicle approval

Every powered road vehicle except a motorcycle needs staff approval before dispatch. The vehicle record includes plate, make, model, colour, payload, body type, roadworthy expiry and insurance expiry. Expired papers suspend the rider and take the vehicle out of dispatch until staff review updated details. Driver licence records continue through the existing rider licence review.

## Cargo pricing setup before launch

Migration `077_cargo_pricing_options.sql` adds active, zero-price placeholder tariffs for the cargo tricycle, pickup, box truck and long vehicle. The API logs a startup warning while placeholders remain. Quotes and customer vehicle pickers ignore placeholders. Van keeps its existing tariff values in a new version with a 15-minute free loading allowance, but its vehicle class remains disabled.

Before enabling any cargo class, a staff member with `pricing:write` must publish real start, per-kilometre, per-minute and minimum fares, commission, helper price, per-floor/per-side price, free loading time and waiting fee through Admin → Tariffs & Commission Control. Placeholder prices are intentionally zero and are not launch prices. Configure the published cargo liability cap and plain-English terms in the Cargo liability terms section; the cap is not an insurance offer. Until both a real tariff and cargo terms exist, cargo quotes are refused.

## Scheduled pickup setup

Box truck and long vehicle quotes require a future pickup window. Other vehicle classes can book without one or may request a window. Windows can be booked up to 14 days ahead and can be no longer than four hours. The quoted amount is fixed when the customer books. The default dispatch lead is 1,440 minutes (24 hours) and staff can adjust it per vehicle class in Admin → Vehicle classes; dispatch still checks the rider's road ETA against the end of the pickup window before offering the job. Riders receive reminders at about 60 and 15 minutes before the pickup. Scheduled cargo can be cancelled without a fee until two hours before its pickup window, after which the existing cancellation fee terms apply.

The customer may declare the goods value. ELESEND stores that amount with the immutable quote for dispute records only; it does not change the fare or buy insurance. The quote displays and snapshots the liability terms in force when it is priced.

## Long-vehicle heavy-freight pricing

Long vehicles use a separate `long_vehicle_pricing_policies` versioned tariff and `long_vehicle_heavy_freight_v1` calculator. The fare uses staff-set base, road-kilometre and loaded tonne-kilometre rates, a configurable return-leg factor, minimum fare, helpers, floors, extra stops, booking fee, tolls and waiting terms. It does not use the standard class start/km/minute formula, time fare or parcel surge multiplier. The quoted engine name and long-vehicle policy version are saved with the quote and fare evidence.

Migration `078_long_vehicle_pricing_engine.sql` seeds only a blank placeholder. Staff must enter every long-vehicle rate in Admin → Long Vehicle Heavy-Freight Engine, then enable the class from Vehicle Classes. The ordinary vehicle tariff endpoint refuses long-vehicle updates, and the class cannot be enabled or quoted until the dedicated rate version is complete. All amounts are integer pesewas; there are no seeded long-haul prices.
