# DiceyClothes

Catalog ingestion for the authorized DiceyClothes supplier feed.

## What this imports

- Every Yupoo album as one catalog product
- The original supplier title, description, size text, code, and source URL
- Every full-size album photo copied into the `product-images` Supabase Storage bucket
- Resumable product/image records, deduplicated by source album and image URL

Products remain inactive after import so unfinished or unpriced items cannot accidentally appear in the storefront.

## Setup

1. Apply `supabase/schema.sql` to the dedicated **DiceyClothes** Supabase project.
2. Copy `.env.example` to `.env` and supply the Yupoo password plus the DiceyClothes Supabase URL and server-side secret key. A publishable key may be used only with the temporary, token-locked import RLS policies.
3. Validate a small sample first:

   ```bash
   IMPORT_END_PAGE=1 IMPORT_LIMIT=2 npm run import:yupoo
   ```

4. Run the complete incremental import:

   ```bash
   npm run import:yupoo
   ```

Never expose `SUPABASE_SECRET_KEY` in browser code or commit `.env`.
