-- Per-feature shop access: existing shop memberships keep every shop tool they could
-- already use. Only rows without any feature.* permission are touched, so re-running is a no-op.
UPDATE "ShopEmployeeMembership"
SET "permissions" = ARRAY(
  SELECT DISTINCT p FROM unnest(
    "permissions" || ARRAY[
      'feature.lists', 'feature.tasks', 'feature.expiry', 'feature.fridges', 'feature.cleaning',
      'feature.incidents', 'feature.age_records', 'feature.waste', 'feature.supplier_payouts', 'feature.shift_sheet'
    ]::TEXT[]
  ) AS p
)
WHERE NOT EXISTS (SELECT 1 FROM unnest("permissions") AS existing WHERE existing LIKE 'feature.%');
