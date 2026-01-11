import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkDatabase() {
    try {
        console.log('🔍 Checking database status...\n');
        
        // Count total products
        const totalCount = await prisma.product.count();
        console.log(`📊 Total products in database: ${totalCount}`);
        
        // Count products by image type
        const imageStats = await prisma.product.groupBy({
            by: ['img'],
            _count: {
                _all: true
            }
        });
        
        console.log('\n🖼️  Image type distribution:');
        const imageCounts = { api: 0, external_downloadable: 0, external: 0, local: 0, none: 0 };
        
        imageStats.forEach(stat => {
            if (stat.img && typeof stat.img === 'object' && stat.img.type) {
                imageCounts[stat.img.type] = (imageCounts[stat.img.type] || 0) + stat._count._all;
            } else {
                imageCounts.none += stat._count._all;
            }
        });
        
        Object.entries(imageCounts).forEach(([type, count]) => {
            if (count > 0) {
                console.log(`   ${type}: ${count} products`);
            }
        });
        
        // Sample products
        const sampleProducts = await prisma.product.findMany({
            take: 5,
            select: {
                id: true,
                title: true,
                barcode: true,
                rrp: true,
                retailSize: true,
                img: true
            }
        });
        
        console.log('\n📝 Sample products:');
        sampleProducts.forEach((product, index) => {
            console.log(`   ${index + 1}. ${product.title}`);
            console.log(`      Barcode: ${product.barcode}`);
            console.log(`      Price: £${product.rrp || 'N/A'}`);
            console.log(`      Size: ${product.retailSize || 'N/A'}`);
            console.log(`      Image: ${product.img?.type || 'none'} - ${product.img?.url || 'N/A'}`);
            console.log('');
        });
        
        // Recent imports
        const recentProducts = await prisma.product.findMany({
            orderBy: { id: 'desc' },
            take: 3,
            select: {
                id: true,
                title: true,
                barcode: true,
                img: true
            }
        });
        
        console.log('🆕 Recent imports:');
        recentProducts.forEach((product, index) => {
            console.log(`   ${index + 1}. ${product.title} (${product.barcode}) - ${product.img?.type || 'no image'}`);
        });
        
    } catch (error) {
        console.error('❌ Error checking database:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

// Run the check
checkDatabase();