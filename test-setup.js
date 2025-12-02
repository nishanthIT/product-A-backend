// Test script to check if test customer exists
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function checkAndCreateTestCustomer() {
  try {
    console.log('Checking for test customer...');
    
    // Check if customer exists
    let customer = await prisma.customer.findUnique({
      where: { email: 'customer1@example.com' }
    });
    
    if (customer) {
      console.log('✅ Test customer already exists:');
      console.log({
        id: customer.id,
        email: customer.email,
        name: customer.name,
      });
    } else {
      console.log('Creating test customer...');
      
      // Hash the password
      const hashedPassword = await bcrypt.hash('securepassword', 10);
      
      // Create customer
      customer = await prisma.customer.create({
        data: {
          email: 'customer1@example.com',
          name: 'Test Customer',
          mobile: '1234567890',
          password: hashedPassword,
          userType: 'CUSTOMER',
        },
      });
      
      console.log('✅ Test customer created:');
      console.log({
        id: customer.id,
        email: customer.email,
        name: customer.name,
      });
    }
    
    // Check for lists
    const lists = await prisma.list.findMany({
      where: { customerId: customer.id },
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
    
    console.log(`\n📋 Customer has ${lists.length} shopping list(s)`);
    
    if (lists.length === 0) {
      console.log('\nCreating a sample shopping list...');
      
      const sampleList = await prisma.list.create({
        data: {
          name: 'Weekly Shopping',
          description: 'My weekly grocery list',
          customerId: customer.id,
        },
      });
      
      console.log('✅ Sample list created:', sampleList.name);
    }
    
    console.log('\n✅ Database is ready for testing!');
    console.log('\nTest credentials:');
    console.log('Email: customer1@example.com');
    console.log('Password: securepassword');
    console.log('User Type: CUSTOMER');
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkAndCreateTestCustomer();
