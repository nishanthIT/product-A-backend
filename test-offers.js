import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function checkOffers() {
  try {
    console.log('🔍 Checking for products with offer prices...');
    
    const productsWithOffers = await prisma.productAtShop.findMany({
      where: {
        offerPrice: { not: null }
      },
      include: {
        product: { select: { title: true } },
        shop: { select: { name: true } }
      }
    });
    
    console.log('✅ Products with offers found:', productsWithOffers.length);
    productsWithOffers.forEach(item => {
      const currentDate = new Date();
      const isExpired = item.offerExpiryDate && new Date(item.offerExpiryDate) <= currentDate;
      console.log(`  - ${item.product.title} at ${item.shop.name}: £${item.price} → £${item.offerPrice} ${isExpired ? '(EXPIRED)' : '(ACTIVE)'}`);
    });
    
    if (productsWithOffers.length === 0) {
      console.log('ℹ️ No products with offers found. Let\'s create a test offer...');
      
      // Find a product to add an offer to
      const testProduct = await prisma.productAtShop.findFirst({
        include: {
          product: { select: { title: true } },
          shop: { select: { name: true } }
        }
      });
      
      if (testProduct) {
        console.log(`🔧 Adding test offer to: ${testProduct.product.title} at ${testProduct.shop.name}`);
        
        const futureDate = new Date();
        futureDate.setDate(futureDate.getDate() + 7); // 7 days from now
        
        await prisma.productAtShop.update({
          where: { id: testProduct.id },
          data: {
            offerPrice: Math.max(1, testProduct.price - 2), // £2 off, minimum £1
            offerExpiryDate: futureDate
          }
        });
        
        console.log(`✅ Test offer created: £${testProduct.price} → £${Math.max(1, testProduct.price - 2)}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkOffers();