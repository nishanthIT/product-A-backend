import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
            console.log(`✓ Image already exists: ${filename}`);
            resolve(filePath);
            return;
        }

        console.log(`⬇️  Downloading: ${filename} from ${url}`);

        const protocol = url.startsWith('https') ? https : http;
        
        const file = fs.createWriteStream(filePath);
        const request = protocol.get(url, (response) => {
            if (response.statusCode === 200) {
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    console.log(`✅ Downloaded: ${filename}`);
                    resolve(filePath);
                });
            } else if (response.statusCode === 302 || response.statusCode === 301) {
                // Handle redirects
                file.close();
                fs.unlink(filePath, () => {});
                downloadImage(response.headers.location, filename)
                    .then(resolve)
                    .catch(reject);
            } else {
                file.close();
                fs.unlink(filePath, () => {});
                reject(new Error(`HTTP ${response.statusCode} for ${url}`));
            }
        }).on('error', (err) => {
            file.close();
            fs.unlink(filePath, () => {});
            reject(err);
        });
        
        // Add timeout
        request.setTimeout(15000, () => {
            request.abort();
            file.close();
            fs.unlink(filePath, () => {});
            reject(new Error(`Timeout downloading ${url}`));
        });
    });
}

// Function to download images from a JSON file
async function downloadImagesFromFile(filePath, category) {
    console.log(`\n📁 Processing images from ${path.basename(filePath)}...`);
    
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        let successCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (const item of data) {
            try {
                // Skip if no EAN or image URL
                if (!item.ean || !item.image_url) {
                    skippedCount++;
                    continue;
                }

                // Skip backend API URLs (they don't need downloading)
                if (item.image_url.includes('backend.h7tex.com/api/image/')) {
                    console.log(`⏭️  Skipping API URL for ${item.ean}: ${item.image_url}`);
                    skippedCount++;
                    continue;
                }

                // Skip default images
                if (item.image_url.includes('default')) {
                    console.log(`⏭️  Skipping default image for ${item.ean}`);
                    skippedCount++;
                    continue;
                }

                // Only download actual product images
                if (item.image_url.startsWith('http')) {
                    const filename = `${item.ean}.jpg`;
                    
                    try {
                        await downloadImage(item.image_url, filename);
                        successCount++;
                    } catch (error) {
                        console.error(`❌ Failed to download ${item.ean}: ${error.message}`);
                        errorCount++;
                    }
                } else {
                    skippedCount++;
                }

                // Add small delay to be nice to the server
                if ((successCount + errorCount) % 10 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

            } catch (error) {
                errorCount++;
                console.error(`Error processing item in ${category}:`, error.message);
            }
        }

        console.log(`✅ ${category}: ${successCount} downloaded, ${skippedCount} skipped, ${errorCount} errors`);
        return { success: successCount, skipped: skippedCount, errors: errorCount };

    } catch (error) {
        console.error(`Failed to process file ${filePath}:`, error);
        return { success: 0, skipped: 0, errors: 1 };
    }
}

// Main download function
async function downloadAllImages() {
    console.log('🖼️  Starting image download process...\n');
    console.log(`📁 Images will be saved to: ${imagesDir}\n`);
    
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
    let totalSkipped = 0;
    let totalErrors = 0;

    try {
        for (const { file, category } of fileCategories) {
            const filePath = path.join(dataDir, file);
            
            if (fs.existsSync(filePath)) {
                const result = await downloadImagesFromFile(filePath, category);
                totalSuccess += result.success;
                totalSkipped += result.skipped;
                totalErrors += result.errors;
            } else {
                console.log(`⚠️  File not found: ${file}`);
            }
        }

        console.log('\n🎉 Download Summary:');
        console.log(`✅ Images downloaded successfully: ${totalSuccess}`);
        console.log(`⏭️  Images skipped: ${totalSkipped}`);
        console.log(`❌ Download errors: ${totalErrors}`);
        console.log(`📁 Images saved in: ${imagesDir}`);

    } catch (error) {
        console.error('Fatal error during download:', error);
    }
}

// Run the download
const isMainScript = process.argv[1] && process.argv[1].endsWith('downloadImages.js');
if (isMainScript) {
    console.log('🚀 Script called directly, starting download...');
    downloadAllImages().catch(console.error);
} else {
    console.log('📦 Script imported as module');
}

export { downloadAllImages };