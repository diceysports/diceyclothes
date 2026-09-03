import 'dotenv/config'

import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import pLimit from 'p-limit'
import { chromium } from 'playwright'
import slugify from 'slugify'

const env = process.env
const baseUrl = (env.YUPOO_BASE_URL || '').replace(/\/$/, '')
const password = env.YUPOO_PASSWORD
const bucket = env.SUPABASE_STORAGE_BUCKET || 'product-images'
const startPage = integerEnv('IMPORT_START_PAGE', 1)
const endPage = integerEnv('IMPORT_END_PAGE', 40)
const importLimit = integerEnv('IMPORT_LIMIT', 0)
const albumConcurrency = integerEnv('IMPORT_CONCURRENCY', 2)
const uploadConcurrency = integerEnv('UPLOAD_CONCURRENCY', 4)
const dryRun = booleanEnv('DRY_RUN', false)
const headless = booleanEnv('HEADLESS', true)

requireEnv('YUPOO_BASE_URL', baseUrl)
requireEnv('YUPOO_PASSWORD', password)
if (!dryRun) {
  requireEnv('SUPABASE_URL', env.SUPABASE_URL)
  requireEnv('SUPABASE_SECRET_KEY', env.SUPABASE_SECRET_KEY)
}

const supabase = dryRun
  ? null
  : createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

const stats = {
  albumsSeen: 0,
  productsCompleted: 0,
  productsFailed: 0,
  imagesUploaded: 0,
  bytesUploaded: 0,
}

let runId = null
let browser

try {
  if (!dryRun) runId = await startImportRun()

  browser = await chromium.launch({ headless })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36',
  })

  const unlockPage = await context.newPage()
  await unlockCatalog(unlockPage)
  await unlockPage.close()

  const galleryPage = await context.newPage()
  const albums = []

  for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
    const pageAlbums = await readGalleryPage(galleryPage, pageNumber)
    console.log(`Gallery page ${pageNumber}: ${pageAlbums.length} albums`)
    albums.push(...pageAlbums)
    if (importLimit > 0 && albums.length >= importLimit) break
  }
  await galleryPage.close()

  const uniqueAlbums = [...new Map(albums.map((album) => [album.albumId, album])).values()]
  const selectedAlbums = importLimit > 0 ? uniqueAlbums.slice(0, importLimit) : uniqueAlbums
  stats.albumsSeen = selectedAlbums.length
  await updateRun()

  const limit = pLimit(albumConcurrency)
  await Promise.all(
    selectedAlbums.map((album) =>
      limit(async () => {
        const page = await context.newPage()
        try {
          await importAlbum(page, album)
          stats.productsCompleted += 1
        } catch (error) {
          stats.productsFailed += 1
          console.error(`Album ${album.albumId} failed:`, error)
          if (!dryRun) await markAlbumFailed(album, error)
        } finally {
          await page.close()
          await updateRun()
        }
      }),
    ),
  )

  await finishRun('complete')
  console.log('Import complete', stats)
} catch (error) {
  console.error('Import failed', error)
  await finishRun('failed', error)
  process.exitCode = 1
} finally {
  await browser?.close()
}

async function unlockCatalog(page) {
  await goto(page, `${baseUrl}/albums`)
  const locked = await page.getByText('Homepage is encrypted', { exact: false }).isVisible()
  if (locked) {
    const input = page.locator('input').last()
    await input.fill(password)
    await page.getByText('confirm', { exact: true }).click()
    await page.waitForTimeout(1_200)
  }

  await goto(page, `${baseUrl}/albums?tab=gallery`)
  await page.locator('a[href*="/albums/"]').first().waitFor({ timeout: 30_000 })
}

async function readGalleryPage(page, pageNumber) {
  await goto(page, `${baseUrl}/albums?tab=gallery&page=${pageNumber}`)
  await page.locator('a[href*="/albums/"]').first().waitFor({ timeout: 30_000 })

  return page.locator('a[href*="/albums/"]').evaluateAll((links) =>
    links
      .map((link) => {
        const match = link.href.match(/\/albums\/(\d+)/)
        if (!match) return null
        const lines = (link.innerText || '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        const maybeCount = Number(lines[0])
        const cover = link.querySelector('img')
        const coverUrl = cover?.getAttribute('data-src') || cover?.getAttribute('src') || null
        return {
          albumId: match[1],
          url: link.href,
          listedImageCount: Number.isFinite(maybeCount) ? maybeCount : 0,
          listedTitle: Number.isFinite(maybeCount) ? lines.slice(1).join(' ') : lines.join(' '),
          coverUrl,
        }
      })
      .filter(Boolean),
  )
}

async function importAlbum(page, album) {
  await goto(page, album.url)
  await page.locator('.showalbumheader__gallerysubtitle').waitFor({ timeout: 30_000 })

  const data = await page.evaluate(() => {
    const header = document.querySelector('.showalbumheader__gallerysubtitle')
    const lines = (header?.innerText || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const title = lines.shift() || ''
    const description = lines.join('\n')
    const images = [...document.querySelectorAll('img[data-src*="photo.yupoo.com"]')]
      .map((image) => ({
        url: image.getAttribute('data-src'),
        filename: image.getAttribute('alt') || null,
      }))
      .filter((image) => image.url && /\/big\.(jpe?g|png|webp)(\?|$)/i.test(image.url))
    const published = document.querySelector('main time')?.getAttribute('datetime') ||
      document.querySelector('main time')?.textContent?.trim() || null
    return { title, description, images, published }
  })

  data.images = [...new Map(data.images.map((image) => [image.url, image])).values()]
  const details = deriveProductDetails(data.title || album.listedTitle, data.description)
  const slug = makeSlug(details.title, album.albumId)

  console.log(`Album ${album.albumId}: ${details.title} (${data.images.length} images)`)
  if (dryRun) return

  const { data: product, error: productError } = await supabase
    .from('catalog_products')
    .upsert(
      {
        source: 'yupoo',
        source_album_id: album.albumId,
        source_url: album.url,
        title_original: details.title,
        description_original: data.description || null,
        brand: details.brand,
        category: details.category,
        supplier_code: details.supplierCode,
        sizes: details.sizes,
        slug,
        cover_url: album.coverUrl,
        expected_image_count: data.images.length || album.listedImageCount,
        import_status: 'importing',
        import_error: null,
        source_published_at: parseDate(data.published),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'source,source_album_id' },
    )
    .select('id')
    .single()
  if (productError) throw productError

  const { data: existing, error: existingError } = await supabase
    .from('product_images')
    .select('position,original_url')
    .eq('product_id', product.id)
  if (existingError) throw existingError
  const existingUrls = new Set((existing || []).map((image) => image.original_url))

  const uploadLimit = pLimit(uploadConcurrency)
  await Promise.all(
    data.images.map((image, position) =>
      uploadLimit(async () => {
        if (existingUrls.has(image.url)) return
        await copyImage(product.id, album.albumId, details.title, image, position)
      }),
    ),
  )

  const { count, error: countError } = await supabase
    .from('product_images')
    .select('*', { count: 'exact', head: true })
    .eq('product_id', product.id)
  if (countError) throw countError

  const complete = count === data.images.length
  const { error: finishError } = await supabase
    .from('catalog_products')
    .update({
      imported_image_count: count || 0,
      import_status: complete ? 'complete' : 'failed',
      import_error: complete ? null : `Expected ${data.images.length} images; stored ${count || 0}`,
      updated_at: new Date().toISOString(),
    })
    .eq('id', product.id)
  if (finishError) throw finishError
  if (!complete) throw new Error(`Image count mismatch: ${count || 0}/${data.images.length}`)
}

async function copyImage(productId, albumId, title, image, position) {
  const response = await fetchWithRetry(image.url, 3)
  const arrayBuffer = await response.arrayBuffer()
  const bytes = new Uint8Array(arrayBuffer)
  const contentType = response.headers.get('content-type') || contentTypeFromUrl(image.url)
  const extension = extensionFromContentType(contentType)
  const fingerprint = createHash('sha1').update(image.url).digest('hex').slice(0, 12)
  const storagePath = `yupoo/${albumId}/${String(position + 1).padStart(2, '0')}-${fingerprint}.${extension}`

  const { error: uploadError } = await supabase.storage.from(bucket).upload(storagePath, bytes, {
    contentType,
    cacheControl: '31536000',
    upsert: false,
  })
  if (uploadError && !/duplicate|already exists/i.test(uploadError.message)) throw uploadError

  const { data: publicData } = supabase.storage.from(bucket).getPublicUrl(storagePath)
  const { error: imageError } = await supabase.from('product_images').upsert(
    {
      product_id: productId,
      position,
      storage_path: storagePath,
      public_url: publicData.publicUrl,
      original_url: image.url,
      alt_text: `${title} - view ${position + 1}`,
      original_filename: image.filename,
      content_type: contentType,
      byte_size: bytes.byteLength,
    },
    { onConflict: 'product_id,original_url' },
  )
  if (imageError) throw imageError

  stats.imagesUploaded += 1
  stats.bytesUploaded += bytes.byteLength
}

async function fetchWithRetry(url, attempts) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { referer: `${baseUrl}/`, 'user-agent': 'Mozilla/5.0 Chrome/152 Safari/537.36' },
      })
      if (!response.ok) throw new Error(`Image HTTP ${response.status}: ${url}`)
      return response
    } catch (error) {
      lastError = error
      if (attempt < attempts) await delay(500 * 2 ** (attempt - 1))
    }
  }
  throw lastError
}

function deriveProductDetails(title, description) {
  const brandMap = [
    ['Balenciaga', /balenciaga|巴黎世家|blcg/i],
    ['Prada', /prada|普拉达/i],
    ['Stone Island', /stone island|石头岛/i],
    ['Acne Studios', /acne studios|\bacne\b/i],
    ['Chrome Hearts', /chrome hearts|克罗心/i],
    ['Louis Vuitton', /louis vuitton|路易威登|\blv\b/i],
    ['Gucci', /gucci|古驰/i],
    ['Burberry', /burberry|巴宝莉|bbr/i],
    ['Ralph Lauren', /ralph lauren|拉夫劳伦/i],
    ['Moncler', /moncler|蒙口/i],
    ['Celine', /celine|赛琳/i],
    ['Loro Piana', /loro piana/i],
    ['Adidas', /adidas/i],
    ['Chanel', /chanel|香奈儿/i],
    ['Miu Miu', /miu miu|缪缪/i],
    ['Loewe', /loewe|罗意威/i],
    ['Patagonia', /patagonia|巴塔哥尼亚/i],
  ]
  const categoryMap = [
    ['Jackets', /夹克|外套|冲锋衣|jacket/i],
    ['Hoodies & Sweatshirts', /卫衣|hoodie|sweatshirt/i],
    ['Shirts', /衬衫|shirt/i],
    ['T-Shirts', /短袖|长袖t恤|t-?shirt/i],
    ['Sweaters', /毛衣|针织|sweater|knit/i],
    ['Pants', /长裤|牛仔裤|休闲裤|pants|jeans/i],
    ['Shorts', /短裤|shorts/i],
    ['Sets', /套装|set/i],
  ]
  const brand = brandMap.find(([, pattern]) => pattern.test(title))?.[0] || null
  const category = categoryMap.find(([, pattern]) => pattern.test(title))?.[0] || 'Clothing'
  const supplierCode = description.match(/编码[:：]\s*([^\n]+)/i)?.[1]?.trim() || null
  const sizes = description.match(/size[:：]\s*([^\n]+)/i)?.[1]?.trim() || null
  return { title: title.trim(), brand, category, supplierCode, sizes }
}

function makeSlug(title, albumId) {
  const base = slugify(title, { lower: true, strict: true, trim: true }).slice(0, 100)
  return `${base || 'product'}-${albumId}`
}

async function startImportRun() {
  const { data, error } = await supabase
    .from('catalog_import_runs')
    .insert({ start_page: startPage, end_page: endPage })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

async function updateRun() {
  if (dryRun || !runId) return
  const { error } = await supabase
    .from('catalog_import_runs')
    .update({
      albums_seen: stats.albumsSeen,
      products_completed: stats.productsCompleted,
      products_failed: stats.productsFailed,
      images_uploaded: stats.imagesUploaded,
      bytes_uploaded: stats.bytesUploaded,
    })
    .eq('id', runId)
  if (error) console.error('Could not update import run:', error.message)
}

async function finishRun(status, error = null) {
  if (dryRun || !runId) return
  await supabase
    .from('catalog_import_runs')
    .update({
      status,
      error: error ? String(error.message || error) : null,
      finished_at: new Date().toISOString(),
      albums_seen: stats.albumsSeen,
      products_completed: stats.productsCompleted,
      products_failed: stats.productsFailed,
      images_uploaded: stats.imagesUploaded,
      bytes_uploaded: stats.bytesUploaded,
    })
    .eq('id', runId)
}

async function markAlbumFailed(album, error) {
  await supabase
    .from('catalog_products')
    .update({ import_status: 'failed', import_error: String(error.message || error).slice(0, 2_000) })
    .eq('source', 'yupoo')
    .eq('source_album_id', album.albumId)
}

async function goto(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
}

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
}

function integerEnv(name, fallback) {
  const value = Number.parseInt(env[name] || '', 10)
  return Number.isFinite(value) ? value : fallback
}

function booleanEnv(name, fallback) {
  if (env[name] == null) return fallback
  return /^(1|true|yes)$/i.test(env[name])
}

function parseDate(value) {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString()
}

function contentTypeFromUrl(url) {
  if (/\.png(?:\?|$)/i.test(url)) return 'image/png'
  if (/\.webp(?:\?|$)/i.test(url)) return 'image/webp'
  return 'image/jpeg'
}

function extensionFromContentType(contentType) {
  if (/png/i.test(contentType)) return 'png'
  if (/webp/i.test(contentType)) return 'webp'
  return 'jpg'
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

