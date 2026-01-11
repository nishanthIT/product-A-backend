import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function updateImageUrlsBatch() {
    console.log('🔄 Updating image URLs in batches...\n');
    
    try {
        const batchSize = 50;
        let skip = 0;
        let totalUpdated = 0;

        while (true) {
            // Get a batch of products with old API images
            const products = await prisma.product.findMany({
                where: {
                    OR: [
                        {
                            img: {
                                path: ['type'],
                                equals: 'api'
                            }
                        },
                        {
                            img: {
                                path: ['url'],
                                string_contains: 'backend.h7tex.com'
                            }
                        }
                    ]
                },
                select: {
                    id: true,
                    barcode: true,
                    img: true
                },
                skip: skip,
                take: batchSize
            });

            if (products.length === 0) {
                break; // No more products to update
            }

            console.log(`📦 Processing batch: ${skip + 1} to ${skip + products.length}`);

            // Update this batch
            const updatePromises = products.map(async (product) => {
                if (!product.barcode) {
                    return null;
                }

                const newImageData = {
                    type: 'production',
                    url: `https://bigsave.h7tex.com/images/${product.barcode}.png`,
                    filename: `${product.barcode}.png`,
                    ean: product.barcode,
                    category: product.img?.category || 'updated'
                };

                return prisma.product.update({
                    where: { id: product.id },
                    data: { img: newImageData }
                });
            });

            await Promise.all(updatePromises);
            totalUpdated += products.length;

            console.log(`   ✅ Updated ${products.length} products in this batch`);
            
            skip += batchSize;

            // Small delay to prevent overwhelming the database
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        console.log(`\n🎉 Successfully updated ${totalUpdated} image URLs to production format!`);
        console.log(`🔗 New URL format: https://bigsave.h7tex.com/images/{barcode}.png`);

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

// Run the update
updateImageUrlsBatch();