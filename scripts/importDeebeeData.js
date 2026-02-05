import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const prisma = new PrismaClient();

// Directories
const archiveDir = path.join(__dirname, '..', 'Archive');
const sourceImagesDir = path.join(archiveDir, 'product_images');
const targetImagesDir = path.join(__dirname, '..', 'uploads', 'images');

// Create target images directory if it doesn't exist
if (!fs.existsSync(targetImagesDir)) {
    fs.mkdirSync(targetImagesDir, { recursive: true });
}

// CSV files to import
const csvFiles = [
    'deebee_bakery.csv',
    'deebee_carrier.csv',
    'deebee_catering.csv',
    'deebee_chill.csv',
    'deebee_crisps.csv',
    'deebee_ecigs.csv',
    'deebee_grocery.csv',
    'deebee_kiosk.csv',
    'deebee_nonfood.csv',
    'deebee_offlic.csv',
    'deebee_petproduct.csv',
    'deebee_softdrnk.csv',
    'deebee_toilet.csv'
];

/**
 * Parse a CSV line, handling quoted fields with commas
 */
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    
    return result;
}

/**
 * Parse CSV file and return array of objects
 */
function parseCSV(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    
    if (lines.length === 0) return [];
    
    const headers = parseCSVLine(lines[0]);
    const data = [];
    
    for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        const row = {};
        
        headers.forEach((header, index) => {
            row[header] = values[index] || '';
        });
        
        data.push(row);
    }
    
    return data;
}

/**
 * Extract the first barcode from the "All Barcodes" field
 * Barcodes are separated by " | "
 */
function getFirstBarcode(allBarcodes) {
    if (!allBarcodes || allBarcodes === 'N/A') return null;
    
    const barcodes = allBarcodes.split(' | ');
    if (barcodes.length === 0) return null;
    
    // Get the first barcode, remove leading zeros for consistency
    let firstBarcode = barcodes[0].trim();
    
    // Some barcodes have leading zeros, keep them as-is for now
    return firstBarcode || null;
}

/**
 * Process RRP value - extract numeric value from string like "21.99"
 */
function processRRP(rrp) {
    if (!rrp || rrp === 'N/A' || rrp === '0.00' || rrp === 'Login Required') {
        return null;
    }
    
    // Remove currency symbols and extract number
    const numericValue = rrp.replace(/[£$€,]/g, '').trim();
    const parsedValue = parseFloat(numericValue);
    
    return isNaN(parsedValue) || parsedValue === 0 ? null : parsedValue;
}

/**
 * Find and copy the best image for a product
 * Returns the image URL if successful
 */
function processProductImage(productId, barcode) {
    if (!barcode) return null;
    
    // Look for images with the product ID prefix in source directory
    const sourceFiles = fs.readdirSync(sourceImagesDir);
    
    // Find all images for this product (productId_0.jpg, productId_1.jpg, etc.)
    const productImages = sourceFiles.filter(file => 
        file.startsWith(`${productId}_`)
    ).sort();
    
    if (productImages.length === 0) {
        return null;
    }
    
    // Use the first image (usually productId_0.jpg or productId_0.png)
    // Prefer jpg over png if available
    let selectedImage = productImages[0];
    
    // Find first .jpg image if exists
    const jpgImage = productImages.find(img => img.endsWith('.jpg'));
    if (jpgImage) {
        selectedImage = jpgImage;
    }
    
    // Copy image to target directory with barcode as filename
    const sourceImagePath = path.join(sourceImagesDir, selectedImage);
    const extension = path.extname(selectedImage);
    const targetFilename = `${barcode}${extension}`;
    const targetImagePath = path.join(targetImagesDir, targetFilename);
    
    try {
        // Skip if target already exists
        if (!fs.existsSync(targetImagePath)) {
            fs.copyFileSync(sourceImagePath, targetImagePath);
        }
        
        return {
            type: 'local',
            url: `/uploads/images/${targetFilename}`,
            filename: targetFilename,
            originalFile: selectedImage
        };
    } catch (error) {
        console.error(`Error copying image for ${barcode}:`, error.message);
        return null;
    }
}

/**
 * Import products from a single CSV file
 */
async function importFromCSV(csvFilename) {
    const filePath = path.join(archiveDir, csvFilename);
    
    if (!fs.existsSync(filePath)) {
        console.log(`⚠️  File not found: ${csvFilename}`);
        return { success: 0, updated: 0, errors: 0, skipped: 0 };
    }
    
    console.log(`\n📁 Processing ${csvFilename}...`);
    
    const data = parseCSV(filePath);
    let successCount = 0;
    let updateCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    
    for (const row of data) {
        try {
            // Extract first barcode
            const barcode = getFirstBarcode(row['All Barcodes']);
            
            if (!barcode) {
                skippedCount++;
                continue;
            }
            
            const productId = row['Product ID'];
            const title = row['Title'] || 'Unknown Product';
            const rrp = processRRP(row['RRP £']);
            const packSize = row['Pack Size'] || null;
            const productUrl = row['Page URL'] || null;
            
            // Process image - copy to uploads with barcode as filename
            const imageInfo = processProductImage(productId, barcode);
            
            // Check if product exists
            const existingProduct = await prisma.product.findUnique({
                where: { barcode }
            });
            
            // Prepare product data
            const productData = {
                title,
                productUrl,
                caseSize: packSize,
                rrp,
                img: imageInfo
            };
            
            if (existingProduct) {
                // Update existing product
                await prisma.product.update({
                    where: { barcode },
                    data: productData
                });
                updateCount++;
            } else {
                // Create new product
                await prisma.product.create({
                    data: {
                        ...productData,
                        barcode
                    }
                });
                successCount++;
            }
            
            // Progress indicator
            const total = successCount + updateCount;
            if (total % 100 === 0) {
                console.log(`   Processed ${total} products...`);
            }
            
        } catch (error) {
            errorCount++;
            if (error.code !== 'P2002') { // Not a duplicate key error
                console.error(`   Error: ${error.message}`);
            }
        }
    }
    
    console.log(`   ✅ New: ${successCount} | Updated: ${updateCount} | Skipped: ${skippedCount} | Errors: ${errorCount}`);
    
    return { 
        success: successCount, 
        updated: updateCount, 
        errors: errorCount, 
        skipped: skippedCount 
    };
}

/**
 * Main import function
 */
async function importAllData() {
    console.log('🚀 Starting Deebee data import...');
    console.log(`📂 Source: ${archiveDir}`);
    console.log(`📂 Images: ${sourceImagesDir} → ${targetImagesDir}`);
    
    let totalNew = 0;
    let totalUpdated = 0;
    let totalErrors = 0;
    let totalSkipped = 0;
    
    try {
        for (const csvFile of csvFiles) {
            const result = await importFromCSV(csvFile);
            totalNew += result.success;
            totalUpdated += result.updated;
            totalErrors += result.errors;
            totalSkipped += result.skipped;
        }
        
        console.log('\n🎉 Import Complete!');
        console.log('═══════════════════════════════════');
        console.log(`✅ New products created: ${totalNew}`);
        console.log(`🔄 Products updated: ${totalUpdated}`);
        console.log(`⏭️  Skipped (no barcode): ${totalSkipped}`);
        console.log(`❌ Errors: ${totalErrors}`);
        console.log(`📁 Images saved to: ${targetImagesDir}`);
        
    } catch (error) {
        console.error('Fatal error during import:', error);
    } finally {
        await prisma.$disconnect();
    }
}

// Run the import
importAllData().catch(console.error);
