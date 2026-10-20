-- Migration 025: Authorize food delivery category for approved transport vehicles
UPDATE vehicle_capabilities
SET allowed_categories = array_append(allowed_categories, 'food')
WHERE vehicle IN ('motorcycle', 'car', 'bicycle', 'tricycle', 'van')
  AND NOT ('food' = ANY(allowed_categories));
