# Product Data Import Guide

This guide explains how to import product data from JSON files into your database and handle image downloads.

## Overview

The import process handles:
- ✅ Product data from all JSON files (nonfood, offlic, petproducts, softdrnk, tobacco, toilet)
- 🖼️ Image downloads from external URLs
- 🔗 Backend API image URL handling
- 💰 Price (RRP) processing
- 🏷️ Product categorization

## Scripts Available

### 1. Download Images Only
```bash
npm run download-images
```
This script only downloads images without importing data to the database. Good for testing image downloads first.

**What it does:**
- Downloads images from external URLs (like dbstatic.co.uk)
- Saves images with EAN barcode as filename (e.g., `5011302119104.jpg`)
- Skips backend API URLs (those stay as API calls)
- Skips default/placeholder images
- Stores all images in `uploads/images/` directory

### 2. Full Import (Recommended)
```bash
npm run import-products
```
This script does everything - downloads images AND imports data to database.

**What it does:**
- Downloads and processes images (same as above)
- Imports all product data to the Product table
- Handles price conversion (£2.29 → 2.29)
- Creates proper image JSON structure
- Updates existing products or creates new ones

## Image Handling

The system handles three types of image URLs:

### 1. External downloadable images
```json
"image_url": "https://www.dbstatic.co.uk/assets/products/small/501130/5011302119104.jpg"
```
- ✅ **Downloaded** and saved as `5011302119104.jpg`
- Stored in: `uploads/images/5011302119104.jpg`
- Database stores: `{"type": "local", "url": "/uploads/images/5011302119104.jpg"}`

### 2. Backend API images  
```json
"image_url": "https://backend.h7tex.com/api/image/3057640373428"
```
- ⏭️ **Not downloaded** (API endpoint)
- Database stores: `{"type": "api", "url": "https://backend.h7tex.com/api/image/3057640373428"}`

### 3. Default/placeholder images
```json
"image_url": "https://www.dbstatic.co.uk/assets/default/default_sm.jpg"
```
- ⏭️ **Skipped** (no useful image)
- Database stores: `{"type": "external", "url": "https://www.dbstatic.co.uk/assets/default/default_sm.jpg"}`

## Database Schema Mapping

| JSON Field | Database Field | Notes |
|------------|----------------|--------|
| `name` | `title` | Product name |
| `ean` | `barcode` | Unique identifier |
| `product_url` | `productUrl` | Product page URL |
| `size` | `retailSize` | Package size info |
| `rrp` | `rrp` | Converted to decimal |
| `image_url` | `img` | JSON object with image info |

## Before Running

1. **Make sure database is running:**
   ```bash
   # Check your .env file has DATABASE_URL
   cat .env
   ```

2. **Run Prisma migrations if needed:**
   ```bash
   npx prisma migrate dev
   ```

3. **Generate Prisma client:**
   ```bash
   npx prisma generate
   ```

## Running the Import

### Option A: Download images first (recommended for testing)
```bash
# 1. Download all images first
npm run download-images

# 2. Then import to database
npm run import-products
```

### Option B: Do everything at once
```bash
npm run import-products
```

## Expected Output

### Download Progress
```
🖼️ Starting image download process...

📁 Processing images from nonfood.json...
⬇️ Downloading: 5011302119104.jpg from https://www.dbstatic.co.uk/...
✅ Downloaded: 5011302119104.jpg
⏭️ Skipping API URL for 3057640373428: https://backend.h7tex.com/api/image/3057640373428
⏭️ Skipping default image for 5013668439919
✅ nonfood: 845 downloaded, 234 skipped, 12 errors

🎉 Download Summary:
✅ Images downloaded successfully: 3245
⏭️ Images skipped: 1876  
❌ Download errors: 23
📁 Images saved in: /path/to/uploads/images
```

### Import Progress
```
🚀 Starting product data import...

Importing products from nonfood.json...
Processed 50 products from nonfood...
Processed 100 products from nonfood...
✅ Completed nonfood.json: 1089 success, 3 errors

🎉 Import Summary:
✅ Total products imported successfully: 5234
❌ Total errors: 12
📁 Images stored in: /path/to/uploads/images
```

## Troubleshooting

### Database Connection Issues
```bash
# Test database connection
npx prisma db pull
```

### Image Download Issues
- Check internet connection
- Some images might be protected/unavailable
- Large images might timeout (15s timeout set)

### Memory Issues (Large datasets)
If you get memory errors, you can import one category at a time by modifying the script.

## File Structure After Import

```
uploads/
  images/
    5011302119104.jpg    # Downloaded from external URL
    5000128932431.jpg    # Downloaded from external URL  
    ...                  # ~3000+ product images

database:
  Product table populated with:
    - All product information
    - Proper image JSON structure
    - Converted prices
    - Category information
```

## Notes

- Products are **upserted** (updated if exists, created if new) based on barcode
- Images are only downloaded once (skips if file exists)
- Failed image downloads don't stop the import process
- All prices are converted to decimal format for database storage
- Backend API image URLs are preserved as-is for your API calls