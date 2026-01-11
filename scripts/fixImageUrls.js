const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fixImageUrls() {
    try {
        console.log('🔍 Finding products that need image URL fixes...');
        
        // Find all products with incorrect image URLs
        const products = await prisma.product.findMany({
            where: {
                img: {
                    not: null
                }
            }
        });

        let fixedCount = 0;
        let batchSize = 50;
        
        console.log(`Found ${products.length} products to check`);

        for (let i = 0; i < products.length; i += batchSize) {
            const batch = products.slice(i, i + batchSize);
            
            for (const product of batch) {
                try {
                    let needsUpdate = false;
                    let updatedImg = product.img;

                    // Check if this product has image data
                    if (product.img && typeof product.img === 'object') {
                        // Fix bigsave.h7tex.com URLs to backend.h7tex.com API
                        if (product.img.url && product.img.url.includes('bigsave.h7tex.com/images/')) {
                            updatedImg = {
                                ...product.img,
                                type: 'api',
                                url: `https://backend.h7tex.com/api/image/${product.barcode}`,
                                filename: null,
                                ean: product.barcode
                            };
                            needsUpdate = true;
                        }
                        // Also handle old production URLs if any
                        else if (product.img.url && product.img.url.includes('h7tex.com/images/')) {
                            updatedImg = {
                                ...product.img,
                                type: 'api', 
                                url: `https://backend.h7tex.com/api/image/${product.barcode}`,
                                filename: null,
                                ean: product.barcode
                            };
                            needsUpdate = true;
                        }
                    }

                    if (needsUpdate) {
                        await prisma.product.update({
                            where: { id: product.id },
                            data: { img: updatedImg }
                        });
                        fixedCount++;
                        
                        if (fixedCount % 100 === 0) {
                            console.log(`✅ Fixed ${fixedCount} product image URLs`);
                        }
                    }
                } catch (error) {
                    console.error(`Error updating product ${product.id}:`, error.message);
                }
            }
        }

        console.log(`🎉 Successfully fixed ${fixedCount} product image URLs to use working backend API format`);
        console.log('All products now use: https://backend.h7tex.com/api/image/[barcode]');

    } catch (error) {
        console.error('Error fixing image URLs:', error);
    } finally {
        await prisma.$disconnect();
    }
}

fixImageUrls().catch(console.error);