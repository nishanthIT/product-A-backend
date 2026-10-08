-- The shop manager role is retired: everyone a shop owner adds is a shop employee.
UPDATE "ShopEmployeeMembership"
SET "role" = 'EMPLOYEE',
    "permissions" = ARRAY(
      SELECT p FROM unnest("permissions") AS p WHERE p NOT IN ('employees.view', 'employees.manage')
    )
WHERE "role" = 'MANAGER'
   OR "permissions" && ARRAY['employees.view', 'employees.manage']::TEXT[];

-- Per-tool access levels: a tool someone could already use (feature.x = read) keeps full
-- write (feature.x.write) and edit (feature.x.edit) access, so nobody loses what they had.
UPDATE "ShopEmployeeMembership" AS m
SET "permissions" = ARRAY(
  SELECT DISTINCT p FROM (
    SELECT unnest(m."permissions") AS p
    UNION
    SELECT base || suffix
    FROM unnest(m."permissions") AS base
    CROSS JOIN (VALUES ('.write'), ('.edit')) AS levels(suffix)
    WHERE base ~ '^feature\.[a-z_]+$'
  ) AS expanded
  ORDER BY p
)
WHERE EXISTS (
  SELECT 1 FROM unnest(m."permissions") AS base
  WHERE base ~ '^feature\.[a-z_]+$'
    AND NOT (m."permissions" @> ARRAY[base || '.write', base || '.edit'])
);
