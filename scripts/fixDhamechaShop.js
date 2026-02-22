import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const prisma = new PrismaClient();

async function fixDhamechaShop() {
    console.log('🔧 Fixing Dhamecha shop duplication...\n');
    
    try {
        // Find the wrong shop (created by import)
        const wrongShop = await prisma.shop.findFirst({
            where: { name: 'Dhamecha Cash and Carry' }
        });
        
        // Find the correct shop (existing)
        const correctShop = await prisma.shop.findFirst({
            where: { name: 'DAM&CHA CASH & CARRY' }
        });
        
        if (!wrongShop) {
            console.log('✓ No duplicate "Dhamecha Cash and Carry" shop found.');
            return;
        }
        
        console.log(`Found duplicate shop: ${wrongShop.name} (ID: ${wrongShop.id})`);
        
        if (!correctShop) {
            console.log('⚠️  "DAM&CHA CASH & CARRY" not found. Renaming duplicate instead...');
            
            // Just rename the shop
            await prisma.shop.update({
                where: { id: wrongShop.id },
                data: { name: 'DAM&CHA CASH & CARRY' }
            });
            console.log('✅ Renamed "Dhamecha Cash and Carry" to "DAM&CHA CASH & CARRY"');
            return;
        }
        
        console.log(`Target shop: ${correctShop.name} (ID: ${correctShop.id})`);
        
        // Count products in wrong shop
        const wrongShopProducts = await prisma.productAtShop.findMany({
            where: { shopId: wrongShop.id }
        });
        
        console.log(`\n📦 Products to move: ${wrongShopProducts.length}`);
        
        if (wrongShopProducts.length > 0) {
            let movedCount = 0;
            let skippedCount = 0;
            
            for (const product of wrongShopProducts) {
                // Check if product already exists in correct shop
                const existingInCorrect = await prisma.productAtShop.findUnique({
                    where: {
                        shopId_productId: {
                            shopId: correctShop.id,
                            productId: product.productId
                        }
                    }
                });
                
                if (existingInCorrect) {
                    // Update price if the new one is higher (or non-zero)
                    if (Number(product.price) > Number(existingInCorrect.price)) {
                        await prisma.productAtShop.update({
                            where: { id: existingInCorrect.id },
                            data: { price: product.price }
                        });
                    }
                    // Delete the duplicate
                    await prisma.productAtShop.delete({
                        where: { id: product.id }
                    });
                    skippedCount++;
                } else {
                    // Move product to correct shop
                    await prisma.productAtShop.update({
                        where: { id: product.id },
                        data: { shopId: correctShop.id }
                    });
                    movedCount++;
                }
                
                if ((movedCount + skippedCount) % 500 === 0) {
                    console.log(`  Progress: ${movedCount + skippedCount}/${wrongShopProducts.length}`);
                }
            }
            
            console.log(`\n✅ Moved: ${movedCount} products`);
            console.log(`✅ Merged (already existed): ${skippedCount} products`);
        }
        
        // Delete the wrong shop
        await prisma.shop.delete({
            where: { id: wrongShop.id }
        });
        
        console.log(`\n🗑️  Deleted duplicate shop: "Dhamecha Cash and Carry"`);
        
        // Final count
        const finalCount = await prisma.productAtShop.count({
            where: { shopId: correctShop.id }
        });
        console.log(`\n📊 DAM&CHA CASH & CARRY now has: ${finalCount} products`);
        
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

fixDhamechaShop();
