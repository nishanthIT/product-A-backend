import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function testOfferPriceLogic() {
  try {
    console.log('🧪 Testing offer price logic...');
    
    // Find the product with an offer
    const productWithOffer = await prisma.productAtShop.findFirst({
      where: {
        offerPrice: { not: null },
        offerExpiryDate: { gt: new Date() } // Active offer
      },
      include: {
        product: true,
        shop: true
      }
    });
    
    if (!productWithOffer) {
      console.log('❌ No active offers found');
      return;
    }
    
    console.log(`📦 Found product with active offer:`);
    console.log(`   Product: ${productWithOffer.product.title}`);
    console.log(`   Shop: ${productWithOffer.shop.name}`);
    console.log(`   Regular Price: £${productWithOffer.price}`);
    console.log(`   Offer Price: £${productWithOffer.offerPrice}`);
    console.log(`   Offer Expires: ${productWithOffer.offerExpiryDate}`);
    
    // Test the helper function logic
    const currentDate = new Date();
    const hasActiveOffer = productWithOffer.offerPrice && 
                          productWithOffer.offerExpiryDate && 
                          new Date(productWithOffer.offerExpiryDate) > currentDate;
    
    const effectivePrice = hasActiveOffer ? productWithOffer.offerPrice : productWithOffer.price;
    
    console.log(`\\n🔍 Price Logic Test:`);
    console.log(`   Current Date: ${currentDate}`);
    console.log(`   Offer Expiry: ${new Date(productWithOffer.offerExpiryDate)}`);
    console.log(`   Has Active Offer: ${hasActiveOffer}`);
    console.log(`   Effective Price: £${effectivePrice}`);
    
    // Now let's create a test list and add this product
    console.log(`\\n📋 Creating test list...`);
    
    // Find a customer
    const customer = await prisma.customer.findFirst();
    if (!customer) {
      console.log('❌ No customer found');
      return;
    }
    
    // Create test list
    const testList = await prisma.list.create({
      data: {
        name: `Test Offer List ${Date.now()}`,
        description: 'Testing offer price logic',
        customerId: customer.id
      }
    });
    
    console.log(`✅ Created test list: ${testList.name}`);
    
    // Simulate the addProductAtList API call
    console.log(`\\n🔧 Simulating addProductAtList with offer price logic...`);
    
    const productId = productWithOffer.productId;
    const listId = testList.id;
    
    // Find all shops that have this product
    const productAtShops = await prisma.productAtShop.findMany({
      where: { productId },
      include: {
        product: true,
        shop: true,
      },
    });
    
    console.log(`📊 Found ${productAtShops.length} shops with this product:`);
    
    // Apply our new logic to find the lowest effective price
    const shopComparison = productAtShops.map(shop => {
      const currentDate = new Date();
      const hasActiveOffer = shop.offerPrice && 
                            shop.offerExpiryDate && 
                            new Date(shop.offerExpiryDate) > currentDate;
      
      const effectivePrice = hasActiveOffer ? shop.offerPrice : shop.price;
      
      console.log(`   ${shop.shop.name}: £${shop.price} ${hasActiveOffer ? `(offer: £${shop.offerPrice}) → £${effectivePrice}` : `→ £${effectivePrice}`}`);
      
      return {
        ...shop,
        effectivePrice,
        hasActiveOffer
      };
    });
    
    // Find the lowest effective price
    const lowestPriceEntry = shopComparison.reduce((lowest, current) => {
      return current.effectivePrice < lowest.effectivePrice ? current : lowest;
    });
    
    console.log(`\\n🏆 Winner: ${lowestPriceEntry.shop.name} with effective price £${lowestPriceEntry.effectivePrice}`);
    console.log(`   ${lowestPriceEntry.hasActiveOffer ? '🎯 Using OFFER price!' : '📝 Using regular price'}`);
    
    // Add to list
    const listProduct = await prisma.listProduct.create({
      data: {
        listId,
        productAtShopId: lowestPriceEntry.id,
      },
    });
    
    console.log(`\\n✅ Product added to list successfully!`);
    console.log(`   List Product ID: ${listProduct.id}`);
    console.log(`   Using shop: ${lowestPriceEntry.shop.name}`);
    console.log(`   Final price: £${lowestPriceEntry.effectivePrice}`);
    
    // Clean up test list
    await prisma.listProduct.delete({ where: { id: listProduct.id } });
    await prisma.list.delete({ where: { id: testList.id } });
    console.log(`\\n🧹 Cleaned up test data`);
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

testOfferPriceLogic();