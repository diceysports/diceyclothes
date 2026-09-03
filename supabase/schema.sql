-- DiceyClothes catalog schema.
-- Apply this to the dedicated DiceyClothes project, never Dicey Shoes.

create table if not exists public.catalog_products (
  id bigint generated always as identity primary key,
  source text not null default 'yupoo',
  source_album_id text not null,
  source_url text not null,
  title_original text not null,
  title_en text,
  description_original text,
  description_en text,
  brand text,
  category text,
  supplier_code text,
  sizes text,
  slug text not null unique,
  cover_url text,
  expected_image_count integer not null default 0 check (expected_image_count >= 0),
  imported_image_count integer not null default 0 check (imported_image_count >= 0),
  price numeric(12,2),
  currency text not null default 'USD' check (currency = 'USD'),
  active boolean not null default false,
  import_status text not null default 'pending'
    check (import_status in ('pending', 'importing', 'complete', 'failed')),
  import_error text,
  source_published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, source_album_id)
);

create table if not exists public.product_images (
  id bigint generated always as identity primary key,
  product_id bigint not null references public.catalog_products(id) on delete cascade,
  position integer not null check (position >= 0),
  storage_path text not null unique,
  public_url text not null,
  original_url text not null,
  alt_text text,
  original_filename text,
  content_type text,
  byte_size bigint check (byte_size is null or byte_size >= 0),
  created_at timestamptz not null default now(),
  unique (product_id, position),
  unique (product_id, original_url)
);

create table if not exists public.catalog_import_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'yupoo',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  start_page integer not null,
  end_page integer not null,
  albums_seen integer not null default 0,
  products_completed integer not null default 0,
  products_failed integer not null default 0,
  images_uploaded integer not null default 0,
  bytes_uploaded bigint not null default 0,
  status text not null default 'running'
    check (status in ('running', 'complete', 'failed')),
  error text
);

create index if not exists catalog_products_active_idx
  on public.catalog_products (active, category, brand);
create index if not exists catalog_products_import_status_idx
  on public.catalog_products (import_status);
create index if not exists product_images_product_position_idx
  on public.product_images (product_id, position);

alter table public.catalog_products enable row level security;
alter table public.product_images enable row level security;
alter table public.catalog_import_runs enable row level security;

revoke all on public.catalog_products from anon, authenticated;
revoke all on public.product_images from anon, authenticated;
revoke all on public.catalog_import_runs from anon, authenticated;

grant select on public.catalog_products to anon, authenticated;
grant select on public.product_images to anon, authenticated;

grant all on public.catalog_products to service_role;
grant all on public.product_images to service_role;
grant all on public.catalog_import_runs to service_role;
grant usage, select on sequence public.catalog_products_id_seq to service_role;
grant usage, select on sequence public.product_images_id_seq to service_role;

drop policy if exists "Public can view active catalog products" on public.catalog_products;
create policy "Public can view active catalog products"
  on public.catalog_products for select
  to anon, authenticated
  using (active = true);

drop policy if exists "Public can view images for active products" on public.product_images;
create policy "Public can view images for active products"
  on public.product_images for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.catalog_products p
      where p.id = product_images.product_id
        and p.active = true
    )
  );

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "Public can read DiceyClothes product images" on storage.objects;
create policy "Public can read DiceyClothes product images"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'product-images');
