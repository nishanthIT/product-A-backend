import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

console.log('Testing database connection...');
console.log('DATABASE_URL:', process.env.DATABASE_URL?.substring(0, 50) + '...');

// Use longer connection timeout for Neon (cold start takes time)
const dbUrl = process.env.DATABASE_URL?.replace('connect_timeout=30', 'connect_timeout=120') + '&pool_timeout=120';
console.log('Using extended timeout...');

const prisma = new PrismaClient({
    datasources: {
        db: { url: dbUrl }
    }
});

async function test() {
    const maxRetries = 3;
    for (let i = 1; i <= maxRetries; i++) {
        try {
            console.log(`\nAttempt ${i}/${maxRetries}: Connecting...`);
            await prisma.$connect();
            console.log('Connected!');
            
            const shopCount = await prisma.shop.count();
            console.log('Shop count:', shopCount);
            
            const shops = await prisma.shop.findMany();
            console.log('Shops:', shops.map(s => s.name));
            return;
            
        } catch (error) {
            console.error(`Attempt ${i} failed:`, error.message);
            if (i < maxRetries) {
                console.log('Waiting 5 seconds before retry...');
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }
    console.error('All connection attempts failed');
}

test().finally(() => prisma.$disconnect());
