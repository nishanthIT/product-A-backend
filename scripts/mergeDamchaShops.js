import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const prisma = new PrismaClient();

async function mergeDamchaShops() {
    console.log('🔧 Merging DAM&CHA CASH & CARRY shops...\n');
    
    try {
        // Original shop (with trailing space, at Croydon)
        const keepShop = await prisma.shop.findFirst({
            where: { id: 'cmhmfswa60000dgqs90qv3x02' }
        });
        
        // New shop (created by import)
        const deleteShop = await prisma.shop.findFirst({
            where: { id: 'cmlxrkeo10001causwy9b1vod' }
        });
        
        if (!keepShop || !deleteShop) {
            console.log('Could not find one of the shops!');
            console.log('Keep shop:', keepShop?.name);
            console.log('Delete shop:', deleteShop?.name);
            return;
        }
        
        console.log(`📌 Keeping: "${keepShop.name}" (${keepShop.address})`);
        console.log(`🗑️  Merging from: "${deleteShop.name}" (${deleteShop.address})`);
        
        // Get products from shop to delete
        const productsToMove = await prisma.productAtShop.findMany({
            where: { shopId: deleteShop.id }
        });
        
        console.log(`\n📦 Products to move: ${productsToMove.length}`);
        
        let movedCount = 0;
        let mergedCount = 0;
        
        for (const product of productsToMove) {
            // Check if product already exists in keep shop
            const existing = await prisma.productAtShop.findUnique({
                where: {
                    shopId_productId: {
                        shopId: keepShop.id,
                        productId: product.productId
                    }
                }
            });
            
            if (existing) {
                // Update price if new one is better (non-zero and higher)
                if (Number(product.price) > 0 && Number(product.price) > Number(existing.price)) {
                    await prisma.productAtShop.update({
                        where: { id: existing.id },
                        data: { price: product.price }
                    });
                }
                // Delete duplicate
                await prisma.productAtShop.delete({
                    where: { id: product.id }
                });
                mergedCount++;
            } else {
                // Move to keep shop
                await prisma.productAtShop.update({
                    where: { id: product.id },
                    data: { shopId: keepShop.id }
                });
                movedCount++;
            }
            
            if ((movedCount + mergedCount) % 500 === 0) {
                console.log(`  Progress: ${movedCount + mergedCount}/${productsToMove.length}`);
            }
        }
        
        console.log(`\n✅ Moved: ${movedCount} products`);
        console.log(`✅ Merged (already existed): ${mergedCount} products`);
        
        // Delete the empty shop
        await prisma.shop.delete({
            where: { id: deleteShop.id }
        });
        console.log(`\n🗑️  Deleted shop: "${deleteShop.name}"`);
        
        // Trim the name of kept shop (remove trailing space)
        await prisma.shop.update({
            where: { id: keepShop.id },
            data: { name: 'DAM&CHA CASH & CARRY' }
        });
        console.log('✅ Fixed shop name (removed trailing space)');
        
        // Final count
        const finalCount = await prisma.productAtShop.count({
            where: { shopId: keepShop.id }
        });
        console.log(`\n📊 DAM&CHA CASH & CARRY now has: ${finalCount} products`);
        
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

mergeDamchaShops();
