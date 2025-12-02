import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Helper function to get effective price (considering active offers)
const getEffectivePrice = (productAtShop) => {
  const currentDate = new Date();
  const hasActiveOffer = productAtShop.offerPrice && 
                        productAtShop.offerExpiryDate && 
                        new Date(productAtShop.offerExpiryDate) > currentDate;
  
  const effectivePrice = hasActiveOffer ? productAtShop.offerPrice : productAtShop.price;
  return {
    price: parseFloat(effectivePrice),
    originalPrice: parseFloat(productAtShop.price),
    offerPrice: productAtShop.offerPrice ? parseFloat(productAtShop.offerPrice) : null,
    hasActiveOffer,
    shopName: productAtShop.shop.name
  };
};

async function testCurrentListState() {
  try {
    console.log('🔍 Testing current list state with offer price logic...');
    
    const listId = 'cmi2p343y0001caykwojpnxef';
    
    // Simulate the getListById function logic
    const list = await prisma.list.findUnique({
      where: {
        id: listId,
      },
      include: {
        products: {
          include: {
            productAtShop: {
              include: {
                product: true,
                shop: true,
              },
            },
          },
        },
      },
    });

    if (!list) {
      console.log('❌ List not found');
      return;
    }

    console.log(`📋 Found list: ${list.name} with ${list.products.length} products`);

    // Group by productId and keep only the entry with lowest effective price
    const productMap = new Map();
    list.products.forEach(lp => {
      const productId = lp.productAtShop.productId;
      const effectivePrice = getEffectivePrice(lp.productAtShop);
      
      console.log(`\n🔍 Processing product: ${lp.productAtShop.product.title}`);
      console.log(`   Shop: ${lp.productAtShop.shop?.name}`);
      console.log(`   Regular Price: £${parseFloat(lp.productAtShop.price)}`);
      console.log(`   Offer Price: ${lp.productAtShop.offerPrice ? '£' + lp.productAtShop.offerPrice : 'None'}`);
      console.log(`   Offer Expiry: ${lp.productAtShop.offerExpiryDate || 'None'}`);
      console.log(`   Has Active Offer: ${effectivePrice.hasActiveOffer}`);
      console.log(`   Effective Price: £${effectivePrice.price}`);
      
      if (!productMap.has(productId) || effectivePrice.price < productMap.get(productId).lowestPrice) {
        productMap.set(productId, {
          id: lp.id,
          productId: productId,
          productName: lp.productAtShop.product.title,
          barcode: lp.productAtShop.product.barcode,
          aielNumber: lp.productAtShop.card_aiel_number,
          lowestPrice: effectivePrice.price,
          originalPrice: effectivePrice.originalPrice,
          offerPrice: effectivePrice.offerPrice,
          hasActiveOffer: effectivePrice.hasActiveOffer,
          shopName: lp.productAtShop.shop?.name || 'No Shop',
          img: lp.productAtShop.product.img,
        });
        
        console.log(`   ✅ SET as lowest price entry (£${effectivePrice.price} ${effectivePrice.hasActiveOffer ? 'OFFER' : 'REGULAR'})`);
      } else {
        console.log(`   ❌ NOT lowest - current lowest is £${productMap.get(productId).lowestPrice}`);
      }
    });

    console.log(`\n📦 Final list with ${productMap.size} unique products:`);
    Array.from(productMap.values()).forEach(product => {
      console.log(`   • ${product.productName}: £${product.lowestPrice} ${product.hasActiveOffer ? '(OFFER)' : '(REGULAR)'} at ${product.shopName}`);
    });

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

testCurrentListState();