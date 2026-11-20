-- Material de cada cobertura, que carga la colega desde su portal
-- (/colega.html → /api/colleague-portal, acción "material").
-- Solo AGREGA columnas: no toca datos existentes.
--  - material_uploaded_at: día y hora en que marcó "Subí el material"
--  - material_edited_at:   día y hora en que marcó "Está editado"
--  - material_photo_count: cuántas fotos son
--  - material_link:        link para descargarlo (solo https)
alter table public.colleague_coverages add column if not exists material_uploaded_at timestamptz;
alter table public.colleague_coverages add column if not exists material_edited_at timestamptz;
alter table public.colleague_coverages add column if not exists material_photo_count integer;
alter table public.colleague_coverages add column if not exists material_link text;

alter table public.colleague_coverages drop constraint if exists colleague_coverages_material_photo_count_check;
alter table public.colleague_coverages add constraint colleague_coverages_material_photo_count_check
  check (material_photo_count is null or material_photo_count between 0 and 100000);
alter table public.colleague_coverages drop constraint if exists colleague_coverages_material_link_check;
alter table public.colleague_coverages add constraint colleague_coverages_material_link_check
  check (material_link is null or (char_length(material_link) <= 2000 and material_link ~* '^https://'));
