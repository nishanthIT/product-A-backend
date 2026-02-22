import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function listShops() {
    try {
        const shops = await prisma.shop.findMany();
        console.log('Available Shops:');
        console.log(JSON.stringify(shops, null, 2));
        console.log(`\nTotal shops: ${shops.length}`);
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

listShops();
