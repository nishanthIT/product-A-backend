import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const prisma = new PrismaClient();

// Function to process RRP value
function processRRP(rrp) {
    if (!rrp || rrp === 'Login Required' || rrp === 'N/A') {
        return null;
    }
    
    // Remove currency symbols and extract number
    const numericValue = rrp.replace(/[£$€,]/g, '').trim();
    const parsedValue = parseFloat(numericValue);
    
    return isNaN(parsedValue) ? null : parsedValue;
}

// Function to process image URL and return image info (without downloading)
function processImageUrl(imageUrl, ean) {
    if (!imageUrl || !ean) return null;

    // Check if it's your working backend API URL
    if (imageUrl.includes('backend.h7tex.com/api/image/')) {
        return {
            type: 'api',
            url: imageUrl,
            filename: null,
            ean: ean
        };
    }

    // Check if it's a downloadable external URL
    if (imageUrl.startsWith('http') && !imageUrl.includes('default')) {
        return {
            type: 'external_downloadable',
            url: imageUrl,
            filename: `${ean}.jpg`, // Store intended filename for later download
            ean: ean
        };
    }

    // For default or other images, keep original URL
    return {
        type: 'external',
        url: imageUrl,
        filename: null,
        ean: ean
    };
}

// Function to import products from a JSON file
async function importProductsFromFile(filePath, category) {
    console.log(`\nImporting products from ${path.basename(filePath)}...`);
    
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        let successCount = 0;
        let errorCount = 0;
        let duplicateCount = 0;

        for (const item of data) {
            try {
                // Skip if no EAN barcode
                if (!item.ean) {
                    console.log(`Skipping item without EAN: ${item.name}`);
                    continue;
                }

                // Process image (without downloading)
                const imageInfo = processImageUrl(item.image_url, item.ean);

                // Prepare image JSON
                let imgJson = null;
                if (imageInfo) {
                    imgJson = {
                        ...imageInfo,
                        category: category
                    };
                }

                // Process RRP
                const rrpValue = processRRP(item.rrp);

                // Check if product already exists
                const existingProduct = await prisma.product.findUnique({
                    where: { barcode: item.ean }
                });

                if (existingProduct) {
                    // Update existing product
                    await prisma.product.update({
                        where: { barcode: item.ean },
                        data: {
                            title: item.name,
                            productUrl: item.product_url,
                            retailSize: item.size,
                            img: imgJson,
                            rrp: rrpValue
                        }
                    });
                    duplicateCount++;
                } else {
                    // Create new product
                    await prisma.product.create({
                        data: {
                            title: item.name,
                            productUrl: item.product_url,
                            barcode: item.ean,
                            retailSize: item.size,
                            img: imgJson,
                            rrp: rrpValue
                        }
                    });
                    successCount++;
                }

                if ((successCount + duplicateCount) % 100 === 0) {
                    console.log(`Processed ${successCount + duplicateCount} products from ${category}...`);
                }

            } catch (error) {
                errorCount++;
                console.error(`Error importing product ${item.name}:`, error.message);
                
                // Continue with next product
                continue;
            }
        }

        console.log(`✅ Completed ${path.basename(filePath)}: ${successCount} new, ${duplicateCount} updated, ${errorCount} errors`);
        return { success: successCount, updated: duplicateCount, errors: errorCount };

    } catch (error) {
        console.error(`Failed to process file ${filePath}:`, error);
        return { success: 0, updated: 0, errors: 1 };
    }
}

// Main import function
async function importAllData() {
    console.log('🚀 Starting product data import (fast mode - no image downloads)...\n');
    
    const dataDir = path.join(__dirname, '..', 'data');
    
    // Define file mappings
    const fileCategories = [
        { file: 'nonfood.json', category: 'nonfood' },
        { file: 'offlic.json', category: 'off-license' },
        { file: 'petproducts.json', category: 'pet-products' },
        { file: 'softdrnk.json', category: 'soft-drinks' },
        { file: 'tobacco.json', category: 'tobacco' },
        { file: 'toilet.json', category: 'toilet' }
    ];

    let totalSuccess = 0;
    let totalUpdated = 0;
    let totalErrors = 0;

    try {
        for (const { file, category } of fileCategories) {
            const filePath = path.join(dataDir, file);
            
            if (fs.existsSync(filePath)) {
                const result = await importProductsFromFile(filePath, category);
                totalSuccess += result.success;
                totalUpdated += result.updated;
                totalErrors += result.errors;
            } else {
                console.log(`⚠️  File not found: ${file}`);
            }
        }

        console.log('\n🎉 Import Summary:');
        console.log(`✅ New products imported: ${totalSuccess}`);
        console.log(`🔄 Existing products updated: ${totalUpdated}`);
        console.log(`❌ Total errors: ${totalErrors}`);
        console.log(`📊 Total products in database: ${totalSuccess + totalUpdated}`);

        // Count image types for summary
        const products = await prisma.product.findMany({
            where: { img: { not: null } },
            select: { img: true }
        });

        const imageCounts = { api: 0, external_downloadable: 0, external: 0, local: 0 };
        products.forEach(product => {
            if (product.img && product.img.type) {
                imageCounts[product.img.type] = (imageCounts[product.img.type] || 0) + 1;
            }
        });

        console.log('\n📸 Image Summary:');
        console.log(`🔗 API images (backend): ${imageCounts.api}`);
        console.log(`⬇️  Downloadable images: ${imageCounts.external_downloadable}`);
        console.log(`📁 Local images: ${imageCounts.local}`);
        console.log(`🌐 Other external images: ${imageCounts.external}`);
        
        console.log('\n💡 Next Steps:');
        console.log('1. Run "npm run download-images" to download external images');
        console.log('2. Images will be saved with EAN as filename (e.g., 5011302119104.jpg)');
        console.log('3. Use the image data in your API responses');

    } catch (error) {
        console.error('Fatal error during import:', error);
    } finally {
        await prisma.$disconnect();
    }
}

// Run the import
const isMainScript = process.argv[1] && process.argv[1].endsWith('fastImport.js');
if (isMainScript) {
    importAllData().catch(console.error);
}

export { importAllData };