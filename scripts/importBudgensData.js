import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const prisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.DATABASE_URL?.includes('connect_timeout') 
                ? process.env.DATABASE_URL 
                : `${process.env.DATABASE_URL}&connect_timeout=60&pool_timeout=60`
        }
    },
    log: ['error', 'warn']
});

// Supplier to Shop mapping
const SUPPLIER_SHOP_MAPPING = {
    'EMBON': 'EM&Bon Cash & Carry',
    'CUT PRICES': 'EM&Bon Cash & Carry',
    'DHAMECHA': 'DAM&CHA CASH & CARRY',
    'BESTWAY': 'Bestway',
    'BOOKER': 'Book&er cash and carry',
    'BUDGEN': 'BUDGENS'
};

// Suppliers to exclude
const EXCLUDED_SUPPLIERS = ['BESTWAY+CUT PRICE'];

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
 * Clean barcode - remove leading zeros but keep original if needed
 */
function cleanBarcode(barcode) {
    if (!barcode) return null;
    
    // Remove leading zeros for lookup
    let cleaned = barcode.replace(/^0+/, '');
    
    // If all zeros, return original
    if (!cleaned) return barcode;
    
    return cleaned;
}

/**
 * Ensure shops exist in database
 */
async function ensureShopsExist() {
    console.log('\n📦 Ensuring shops exist...');
    
    const shopIds = {};
    
    for (const [supplier, shopName] of Object.entries(SUPPLIER_SHOP_MAPPING)) {
        // Check if shop exists
        let shop = await prisma.shop.findFirst({
            where: { name: shopName }
        });
        
        if (!shop) {
            // Create shop
            shop = await prisma.shop.create({
                data: {
                    name: shopName,
                    address: `${shopName} Address`,
                    mobile: '0000000000'
                }
            });
            console.log(`  ✅ Created shop: ${shopName}`);
        } else {
            console.log(`  ✓ Shop exists: ${shopName} (ID: ${shop.id})`);
        }
        
        shopIds[supplier] = shop.id;
    }
    
    return shopIds;
}

/**
 * Import products from BUDGENS.csv
 */
async function importBudgensData() {
    console.log('🚀 Starting BUDGENS.csv import...\n');
    
    const csvPath = path.join(__dirname, '..', '..', 'BUDGENS.csv');
    
    if (!fs.existsSync(csvPath)) {
        console.error(`❌ File not found: ${csvPath}`);
        return;
    }
    
    // Ensure shops exist and get their IDs
    const shopIds = await ensureShopsExist();
    
    console.log('\n📁 Parsing CSV file...');
    const data = parseCSV(csvPath);
    console.log(`  Total rows: ${data.length}`);
    
    // Filter for our target suppliers
    const targetData = data.filter(row => {
        const supplier = row.Supplier?.trim();
        return SUPPLIER_SHOP_MAPPING[supplier] && !EXCLUDED_SUPPLIERS.includes(supplier);
    });
    
    console.log(`  Products to process: ${targetData.length}`);
    
    // Group by supplier for stats
    const supplierCounts = {};
    targetData.forEach(row => {
        const supplier = row.Supplier?.trim();
        supplierCounts[supplier] = (supplierCounts[supplier] || 0) + 1;
    });
    
    console.log('\n📊 Products by supplier:');
    for (const [supplier, count] of Object.entries(supplierCounts)) {
        console.log(`  ${supplier} → ${SUPPLIER_SHOP_MAPPING[supplier]}: ${count} products`);
    }
    
    // Process products
    let successCount = 0;
    let notFoundCount = 0;
    let errorCount = 0;
    let duplicateCount = 0;
    
    const notFoundProducts = [];
    
    console.log('\n🔄 Processing products...\n');
    
    for (let i = 0; i < targetData.length; i++) {
        const row = targetData[i];
        
        try {
            const barcode = row.Barcode?.trim();
            const supplier = row.Supplier?.trim();
            const costPerCase = parseFloat(row.CostPerCase) || 0;
            const description = row.Description?.trim();
            
            if (!barcode) {
                notFoundCount++;
                continue;
            }
            
            const shopId = shopIds[supplier];
            if (!shopId) {
                errorCount++;
                continue;
            }
            
            // Try to find product by barcode (try both original and cleaned)
            let product = await prisma.product.findUnique({
                where: { barcode: barcode }
            });
            
            // If not found, try cleaned barcode
            if (!product) {
                const cleanedBarcode = cleanBarcode(barcode);
                if (cleanedBarcode !== barcode) {
                    product = await prisma.product.findUnique({
                        where: { barcode: cleanedBarcode }
                    });
                }
            }
            
            // If still not found, try with leading zeros
            if (!product && barcode.length < 13) {
                const paddedBarcode = barcode.padStart(13, '0');
                product = await prisma.product.findUnique({
                    where: { barcode: paddedBarcode }
                });
            }
            
            if (!product) {
                notFoundCount++;
                notFoundProducts.push({ barcode, description, supplier });
                continue;
            }
            
            // Check if ProductAtShop already exists
            const existingProductAtShop = await prisma.productAtShop.findUnique({
                where: {
                    shopId_productId: {
                        shopId: shopId,
                        productId: product.id
                    }
                }
            });
            
            if (existingProductAtShop) {
                // Update existing price
                await prisma.productAtShop.update({
                    where: { id: existingProductAtShop.id },
                    data: { price: costPerCase }
                });
                duplicateCount++;
            } else {
                // Create new ProductAtShop
                await prisma.productAtShop.create({
                    data: {
                        shopId: shopId,
                        productId: product.id,
                        price: costPerCase
                    }
                });
                successCount++;
            }
            
            // Progress update
            if ((i + 1) % 500 === 0) {
                console.log(`  Processed ${i + 1}/${targetData.length}... (${successCount} added, ${duplicateCount} updated)`);
            }
            
        } catch (error) {
            errorCount++;
            if (errorCount <= 5) {
                console.error(`  Error processing row ${i + 1}:`, error.message);
            }
        }
    }
    
    // Final summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 IMPORT SUMMARY');
    console.log('='.repeat(60));
    console.log(`  ✅ New ProductAtShop created: ${successCount}`);
    console.log(`  🔄 Existing updated: ${duplicateCount}`);
    console.log(`  ⚠️  Products not found in DB: ${notFoundCount}`);
    console.log(`  ❌ Errors: ${errorCount}`);
    console.log('='.repeat(60));
    
    // Save not found products to file for reference
    if (notFoundProducts.length > 0) {
        const notFoundPath = path.join(__dirname, 'budgens_not_found.json');
        fs.writeFileSync(notFoundPath, JSON.stringify(notFoundProducts, null, 2));
        console.log(`\n📄 Not found products saved to: budgens_not_found.json`);
    }
    
    // Per-shop summary
    console.log('\n📦 Per-shop summary:');
    for (const [supplier, shopName] of Object.entries(SUPPLIER_SHOP_MAPPING)) {
        const shopId = shopIds[supplier];
        const count = await prisma.productAtShop.count({
            where: { shopId }
        });
        console.log(`  ${shopName}: ${count} products`);
    }
}

// Run the import
importBudgensData()
    .then(() => {
        console.log('\n✨ Import completed!');
    })
    .catch((error) => {
        console.error('Import failed:', error);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
