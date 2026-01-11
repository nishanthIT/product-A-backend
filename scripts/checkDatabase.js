import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkDatabase() {
    try {
        console.log('🔍 Checking database status...\n');
        
        // Count total products
        const productCount = await prisma.product.count();
        console.log(`📦 Total products in database: ${productCount}`);
        
        if (productCount > 0) {
            // Get sample of products
            const sampleProducts = await prisma.product.findMany({
                take: 5,
                select: {
                    id: true,
                    title: true,
                    barcode: true,
                    rrp: true,
                    img: true
                }
            });
            
            console.log('\n📄 Sample products:');
            sampleProducts.forEach((product, index) => {
                console.log(`${index + 1}. ${product.title}`);
                console.log(`   Barcode: ${product.barcode}`);
                console.log(`   RRP: £${product.rrp || 'N/A'}`);
                console.log(`   Image type: ${product.img?.type || 'none'}\n`);
            });
            
            // Count by image types
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
            
            console.log('📸 Image type breakdown:');
            Object.entries(imageCounts).forEach(([type, count]) => {
                console.log(`   ${type}: ${count}`);
            });
        }
        
    } catch (error) {
        console.error('❌ Database error:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

checkDatabase();