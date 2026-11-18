// What a delivery company can sign up for. Kept apart from company.mjs, which depends on other modules,
// so the registration form can read it while modules are still loading.
export const ACCEPTED_SERVICES=Object.freeze(['delivery','riders']);
