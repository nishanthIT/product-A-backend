import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function addTestPromotions() {
  try {
    console.log('🔄 Adding test promotions...');

    // First, let's check if we have any shops
    const shops = await prisma.shop.findMany();
    console.log('Found shops:', shops.length);

    if (shops.length === 0) {
      console.log('Creating test shop...');
      await prisma.shop.create({
        data: {
          name: 'Test Wholesale Store',
          address: '123 Main St, Test City',
          phone: '123-456-7890',
          email: 'test@wholesale.com'
        }
      });
    }

    // Get the first shop
    const shop = await prisma.shop.findFirst();

    // Check if we have any products
    const products = await prisma.product.findMany();
    console.log('Found products:', products.length);

    if (products.length === 0) {
      console.log('Creating test products...');
      await prisma.product.createMany({
        data: [
          {
            title: 'Premium Coffee Beans',
            barcode: '1234567890123',
            category: 'Beverages',
            img: ['https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=400']
          },
          {
            title: 'Fresh Organic Vegetables',
            barcode: '1234567890124', 
            category: 'Produce',
            img: ['https://images.unsplash.com/photo-1542838132-92c53300491e?w=400']
          },
          {
            title: 'Dairy Products Bundle',
            barcode: '1234567890125',
            category: 'Dairy',
            img: ['https://images.unsplash.com/photo-1550583724-b2692b85b150?w=400']
          }
        ]
      });
    }

    // Get products
    const allProducts = await prisma.product.findMany();

    // Check if we already have promotions
    const existingPromotions = await prisma.promotion.findMany();
    console.log('Existing promotions:', existingPromotions.length);

    if (existingPromotions.length === 0) {
      console.log('Creating test promotions...');

      const testPromotions = [
        {
          title: 'Bulk Coffee Sale',
          description: 'Get premium coffee beans at wholesale prices. Perfect for cafes and restaurants.',
          imageUrl: 'https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=400',
          shopId: shop.id,
          validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
          products: {
            connect: allProducts.slice(0, 2).map(p => ({ id: p.id }))
          }
        },
        {
          title: 'Fresh Produce Special',
          description: 'Get the freshest vegetables and fruits at unbeatable wholesale prices.',
          imageUrl: 'https://images.unsplash.com/photo-1542838132-92c53300491e?w=400',
          shopId: shop.id,
          validUntil: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days from now
          products: {
            connect: [{ id: allProducts[1].id }]
          }
        },
        {
          title: 'Dairy Bundle Deal',
          description: 'Complete dairy package with extended shelf life for your business.',
          imageUrl: 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=400',
          shopId: shop.id,
          validUntil: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000), // 21 days from now
          products: {
            connect: [{ id: allProducts[2].id }]
          }
        }
      ];

      for (const promotion of testPromotions) {
        await prisma.promotion.create({
          data: promotion
        });
      }

      console.log('✅ Test promotions created successfully!');
    } else {
      console.log('✅ Promotions already exist in database');
    }

    // Verify the promotions were created
    const promotions = await prisma.promotion.findMany({
      include: {
        shop: true,
        products: true
      }
    });

    console.log(`📊 Total promotions in database: ${promotions.length}`);
    promotions.forEach(promo => {
      console.log(`- ${promo.title} (${promo.products.length} products)`);
    });

  } catch (error) {
    console.error('❌ Error adding test promotions:', error);
  } finally {
    await prisma.$disconnect();
  }
}

addTestPromotions();