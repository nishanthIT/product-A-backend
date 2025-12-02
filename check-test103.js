import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function checkTest103Entries() {
  try {
    const products = await prisma.productAtShop.findMany({
      where: {
        product: {
          title: {
            contains: 'test103'
          }
        }
      },
      include: {
        product: {
          select: {
            title: true
          }
        },
        shop: {
          select: {
            name: true
          }
        }
      }
    });

    console.log('test103 entries found:', products.length);
    products.forEach(p => {
      const currentDate = new Date();
      const hasActiveOffer = p.offerPrice && p.offerExpiryDate && new Date(p.offerExpiryDate) > currentDate;
      
      console.log(`\n${p.product.title} at ${p.shop.name}:`);
      console.log(`  ID: ${p.id}`);
      console.log(`  Regular Price: £${p.price}`);
      console.log(`  Offer Price: ${p.offerPrice ? '£' + p.offerPrice : 'None'}`);
      console.log(`  Offer Expiry: ${p.offerExpiryDate || 'None'}`);
      console.log(`  Active Offer: ${hasActiveOffer ? 'YES' : 'NO'}`);
      console.log(`  Effective Price: £${hasActiveOffer ? p.offerPrice : p.price}`);
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkTest103Entries();