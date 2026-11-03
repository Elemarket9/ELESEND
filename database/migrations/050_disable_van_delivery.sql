-- Van delivery stays off until it has road routing. Administrators can re-enable it through the vehicle policy.
UPDATE vehicle_capabilities SET enabled = false WHERE vehicle = 'van';
