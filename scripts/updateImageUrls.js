import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function updateImageUrls() {
    console.log('🔄 Updating image URLs to production format...\n');
    
    try {
        // Get all products with API type images
        const productsWithApiImages = await prisma.product.findMany({
            where: {
                img: {
                    path: ['type'],
                    equals: 'api'
                }
            },
            select: {
                id: true,
                barcode: true,
                img: true
            }
        });

        console.log(`📊 Found ${productsWithApiImages.length} products with API images to update`);

        let updateCount = 0;
        let errorCount = 0;

        for (const product of productsWithApiImages) {
            try {
                if (!product.barcode) {
                    console.log(`⏭️  Skipping product ${product.id} - no barcode`);
                    continue;
                }

                // Create new production image URL
                const newImageData = {
                    type: 'production',
                    url: `https://bigsave.h7tex.com/images/${product.barcode}.png`,
                    filename: `${product.barcode}.png`,
                    ean: product.barcode,
                    category: product.img?.category || 'updated'
                };

                // Update the product
                await prisma.product.update({
                    where: { id: product.id },
                    data: {
                        img: newImageData
                    }
                });

                updateCount++;

                if (updateCount % 100 === 0) {
                    console.log(`   ✅ Updated ${updateCount} image URLs...`);
                }

            } catch (error) {
                errorCount++;
                console.error(`❌ Error updating product ${product.id}:`, error.message);
            }
        }

        console.log('\n🎉 Image URL Update Summary:');
        console.log(`✅ Successfully updated: ${updateCount} products`);
        console.log(`❌ Errors: ${errorCount}`);
        console.log(`🔗 New URL format: https://bigsave.h7tex.com/images/{barcode}.png`);

        // Show some examples
        const sampleProducts = await prisma.product.findMany({
            where: {
                img: {
                    path: ['type'],
                    equals: 'production'
                }
            },
            select: {
                title: true,
                barcode: true,
                img: true
            },
            take: 3
        });

        console.log('\n📝 Sample updated products:');
        sampleProducts.forEach((product, index) => {
            console.log(`   ${index + 1}. ${product.title}`);
            console.log(`      Barcode: ${product.barcode}`);
            console.log(`      Image URL: ${product.img?.url}`);
            console.log('');
        });

    } catch (error) {
        console.error('❌ Fatal error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

// Run the update
updateImageUrls();