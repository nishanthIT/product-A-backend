import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const prisma = new PrismaClient();

// Create images directory if it doesn't exist
const imagesDir = path.join(__dirname, '..', 'uploads', 'images');
if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
}

// Function to download image from URL
async function downloadImage(url, filename) {
    return new Promise((resolve, reject) => {
        const filePath = path.join(imagesDir, filename);
        
        // Skip if file already exists
        if (fs.existsSync(filePath)) {
            console.log(`Image already exists: ${filename}`);
            resolve(filePath);
            return;
        }

        const protocol = url.startsWith('https') ? https : http;
        
        const file = fs.createWriteStream(filePath);
        const request = protocol.get(url, (response) => {
            if (response.statusCode === 200) {
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    console.log(`Downloaded: ${filename}`);
                    resolve(filePath);
                });
            } else {
                file.close();
                fs.unlink(filePath, () => {}); // Delete the file on error
                reject(new Error(`Failed to download ${url}: ${response.statusCode}`));
            }
        }).on('error', (err) => {
            file.close();
            fs.unlink(filePath, () => {}); // Delete the file on error
            reject(err);
        });
        
        // Add timeout
        request.setTimeout(10000, () => {
            request.abort();
            reject(new Error(`Timeout downloading ${url}`));
        });
    });
}

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

// Function to process image URL and return image info
async function processImageUrl(imageUrl, ean) {
    if (!imageUrl || !ean) return null;

    try {
        // Check if it's your backend API URL
        if (imageUrl.includes('backend.h7tex.com/api/image/')) {
            return {
                type: 'api',
                url: imageUrl,
                filename: null
            };
        }

        // Check if it's a downloadable external URL
        if (imageUrl.startsWith('http') && !imageUrl.includes('default')) {
            // Try to download, but don't fail import if download fails
            const filename = `${ean}.jpg`;
            
            try {
                await downloadImage(imageUrl, filename);
                return {
                    type: 'local',
                    url: `/uploads/images/${filename}`,
                    filename: filename
                };
            } catch (error) {
                // If download fails, store as external URL for later download
                console.log(`📎 Storing external URL for later: ${ean}`);
                return {
                    type: 'external',
                    url: imageUrl,
                    filename: filename, // Store intended filename for later use
                    ean: ean
                };
            }
        }

        // For default or other images, keep original URL
        return {
            type: 'external',
            url: imageUrl,
            filename: null
        };
    } catch (error) {
        console.error(`Error processing image for EAN ${ean}:`, error.message);
        return {
            type: 'external',
            url: imageUrl,
            filename: null
        };
    }
}

// Function to import products from a JSON file
async function importProductsFromFile(filePath, category) {
    console.log(`\nImporting products from ${path.basename(filePath)}...`);
    
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        let successCount = 0;
        let errorCount = 0;

        for (const item of data) {
            try {
                // Skip if no EAN barcode
                if (!item.ean) {
                    console.log(`Skipping item without EAN: ${item.name}`);
                    continue;
                }

                // Process image
                const imageInfo = await processImageUrl(item.image_url, item.ean);

                // Prepare image JSON
                let imgJson = null;
                if (imageInfo) {
                    imgJson = {
                        type: imageInfo.type,
                        url: imageInfo.url,
                        filename: imageInfo.filename,
                        category: category
                    };
                }

                // Process RRP
                const rrpValue = processRRP(item.rrp);

                // Create or update product
                const product = await prisma.product.upsert({
                    where: { barcode: item.ean },
                    update: {
                        title: item.name,
                        productUrl: item.product_url,
                        retailSize: item.size,
                        img: imgJson,
                        rrp: rrpValue
                    },
                    create: {
                        title: item.name,
                        productUrl: item.product_url,
                        barcode: item.ean,
                        retailSize: item.size,
                        img: imgJson,
                        rrp: rrpValue
                    }
                });

                successCount++;
                
                if (successCount % 50 === 0) {
                    console.log(`Processed ${successCount} products from ${category}...`);
                }

            } catch (error) {
                errorCount++;
                console.error(`Error importing product ${item.name}:`, error.message);
                
                // Continue with next product
                continue;
            }
        }

        console.log(`✅ Completed ${path.basename(filePath)}: ${successCount} success, ${errorCount} errors`);
        return { success: successCount, errors: errorCount };

    } catch (error) {
        console.error(`Failed to process file ${filePath}:`, error);
        return { success: 0, errors: 1 };
    }
}

// Main import function
async function importAllData() {
    console.log('🚀 Starting product data import...\n');
    
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
    let totalErrors = 0;

    try {
        for (const { file, category } of fileCategories) {
            const filePath = path.join(dataDir, file);
            
            if (fs.existsSync(filePath)) {
                const result = await importProductsFromFile(filePath, category);
                totalSuccess += result.success;
                totalErrors += result.errors;
            } else {
                console.log(`⚠️  File not found: ${file}`);
            }
        }

        console.log('\n🎉 Import Summary:');
        console.log(`✅ Total products imported successfully: ${totalSuccess}`);
        console.log(`❌ Total errors: ${totalErrors}`);
        console.log(`📁 Images stored in: ${imagesDir}`);

    } catch (error) {
        console.error('Fatal error during import:', error);
    } finally {
        await prisma.$disconnect();
    }
}

// Run the import
const isMainScript = process.argv[1] && process.argv[1].endsWith('importProductData.js');
if (isMainScript) {
    importAllData().catch(console.error);
}

export { importAllData };