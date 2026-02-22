import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const prisma = new PrismaClient();

async function listAllShops() {
    try {
        const shops = await prisma.shop.findMany({
            include: {
                _count: {
                    select: { products: true }
                }
            }
        });
        
        console.log('All shops in database:\n');
        shops.forEach(shop => {
            console.log(`Name: "${shop.name}"`);
            console.log(`  ID: ${shop.id}`);
            console.log(`  Address: ${shop.address}`);
            console.log(`  Products: ${shop._count.products}`);
            console.log('');
        });
        
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

listAllShops();
