import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Copy our helper function
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

async function demonstrateNewLogic() {
  try {
    console.log('🎯 Demonstrating NEW offer-aware logic for test103...\n');
    
    const listId = 'cmi2p343y0001caykwojpnxef';
    const productId = 'cm80obn580000uk4skwspgbdm'; // test103
    
    // Step 1: Find all shops with this product (simulate addProductAtList logic)
    const productAtShops = await prisma.productAtShop.findMany({
      where: { productId },
      include: {
        product: true,
        shop: true,
      },
    });

    console.log(`📊 Found ${productAtShops.length} shops with test103:`);
    
    const shopComparison = productAtShops.map(shop => {
      const effectivePrice = getEffectivePrice(shop);
      
      console.log(`\n  🏪 ${shop.shop.name}:`);
      console.log(`     Regular Price: £${shop.price}`);
      console.log(`     Offer Price: ${shop.offerPrice ? '£' + shop.offerPrice : 'None'}`);
      console.log(`     Offer Expiry: ${shop.offerExpiryDate || 'None'}`);
      console.log(`     Has Active Offer: ${effectivePrice.hasActiveOffer ? 'YES ✅' : 'NO ❌'}`);
      console.log(`     Effective Price: £${effectivePrice.price} ${effectivePrice.hasActiveOffer ? '(OFFER PRICE!)' : '(regular)'}`);
      
      return {
        ...shop,
        effectivePrice
      };
    });
    
    // Step 2: Find the lowest effective price (our new logic)
    const lowestPriceEntry = shopComparison.reduce((lowest, current) => {
      return current.effectivePrice.price < lowest.effectivePrice.price ? current : lowest;
    });
    
    console.log(`\n🏆 NEW LOGIC WINNER:`);
    console.log(`   Shop: ${lowestPriceEntry.shop.name}`);
    console.log(`   Effective Price: £${lowestPriceEntry.effectivePrice.price}`);
    console.log(`   Using: ${lowestPriceEntry.effectivePrice.hasActiveOffer ? 'OFFER PRICE 🎯' : 'Regular Price'}`);
    
    // Step 3: Compare with what's currently in the list
    console.log(`\n📋 CURRENT LIST ENTRY:`);
    const currentListEntry = await prisma.listProduct.findFirst({
      where: {
        listId,
        productAtShop: {
          productId
        }
      },
      include: {
        productAtShop: {
          include: {
            product: true,
            shop: true
          }
        }
      }
    });
    
    if (currentListEntry) {
      const currentEffective = getEffectivePrice(currentListEntry.productAtShop);
      console.log(`   Current Shop: ${currentListEntry.productAtShop.shop.name}`);
      console.log(`   Current Price: £${currentEffective.price}`);
      console.log(`   Current Type: ${currentEffective.hasActiveOffer ? 'OFFER' : 'Regular'}`);
      
      // Show the difference
      const savings = currentEffective.price - lowestPriceEntry.effectivePrice.price;
      console.log(`\n💰 POTENTIAL SAVINGS: £${savings.toFixed(2)}`);
      console.log(`   Current: £${currentEffective.price} at ${currentEffective.shopName}`);
      console.log(`   Better:  £${lowestPriceEntry.effectivePrice.price} at ${lowestPriceEntry.effectivePrice.shopName} ${lowestPriceEntry.effectivePrice.hasActiveOffer ? '(WITH OFFER!)' : ''}`);
    }
    
    console.log(`\n✨ This demonstrates that our new logic correctly identifies the offer price!`);
    console.log(`   To see this in action, remove test103 from the list and add it back.`);
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

demonstrateNewLogic();