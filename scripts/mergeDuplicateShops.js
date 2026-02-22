import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const prisma = new PrismaClient();

async function mergeDuplicateShops() {
    console.log('🔧 Merging duplicate DAM&CHA CASH & CARRY shops...\n');
    
    try {
        // Find all shops with this name
        const damchaShops = await prisma.shop.findMany({
            where: { name: 'DAM&CHA CASH & CARRY' },
            include: {
                _count: {
                    select: { products: true }
                }
            }
        });
        
        console.log(`Found ${damchaShops.length} shops named "DAM&CHA CASH & CARRY":`);
        damchaShops.forEach(shop => {
            console.log(`  - ID: ${shop.id}, Address: ${shop.address}, Products: ${shop._count.products}`);
        });
        
        if (damchaShops.length <= 1) {
            console.log('\n✓ No duplicates to merge.');
            return;
        }
        
        // Keep the one with "Croydon" address (original), delete the new one
        const keepShop = damchaShops.find(s => s.address.includes('Croydon')) || damchaShops[0];
        const deleteShops = damchaShops.filter(s => s.id !== keepShop.id);
        
        console.log(`\n📌 Keeping shop: ID ${keepShop.id} (${keepShop.address})`);
        console.log(`🗑️  Will merge and delete: ${deleteShops.map(s => s.id).join(', ')}`);
        
        for (const deleteShop of deleteShops) {
            // Get all products from shop to delete
            const productsToMove = await prisma.productAtShop.findMany({
                where: { shopId: deleteShop.id }
            });
            
            console.log(`\n📦 Moving ${productsToMove.length} products from ${deleteShop.id}...`);
            
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
                    // Update price if new one is better
                    if (Number(product.price) > Number(existing.price)) {
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
            
            console.log(`  ✅ Moved: ${movedCount}, Merged: ${mergedCount}`);
            
            // Delete the empty shop
            await prisma.shop.delete({
                where: { id: deleteShop.id }
            });
            console.log(`  🗑️  Deleted shop: ${deleteShop.id}`);
        }
        
        // Final count
        const finalCount = await prisma.productAtShop.count({
            where: { shopId: keepShop.id }
        });
        console.log(`\n✅ DAM&CHA CASH & CARRY now has: ${finalCount} products`);
        
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

mergeDuplicateShops();
