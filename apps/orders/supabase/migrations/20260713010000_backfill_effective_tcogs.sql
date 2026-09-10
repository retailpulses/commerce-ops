-- Issue #122: restore structured TCOGS values used by Portal margin calculations.
-- Values were retained in raw_payload during the product migration, but many
-- are formatted with thousands separators and cannot be cast directly.

update product_commercials
set effective_tcogs = regexp_replace(
  btrim(raw_payload ->> 'effective_tcogs'),
  '[,[:space:]]',
  '',
  'g'
)::numeric
where effective_tcogs is null
  and nullif(btrim(raw_payload ->> 'effective_tcogs'), '') is not null
  and regexp_replace(
    btrim(raw_payload ->> 'effective_tcogs'),
    '[,[:space:]]',
    '',
    'g'
  ) ~ '^[+-]?[0-9]+([.][0-9]+)?$';
