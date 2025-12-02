import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function createTestChat() {
  try {
    // Get customer with id 4 (the one you're logged in as)
    const customer = await prisma.customer.findUnique({
      where: { id: 4 }
    });

    if (!customer) {
      console.log('❌ Customer with id 4 not found');
      return;
    }

    console.log('✅ Found customer:', customer.name);

    // Get another customer or employee for the group
    const otherCustomer = await prisma.customer.findFirst({
      where: { 
        id: { not: 4 }
      }
    });

    const employee = await prisma.empolyee.findFirst();

    console.log('Other participant:', otherCustomer?.name || employee?.name);

    // Create a group chat
    const chat = await prisma.chat.create({
      data: {
        type: 'GROUP',
        name: 'Test Group Chat',
        participants: {
          create: [
            {
              userId: 4,
              userType: 'CUSTOMER',
              isAdmin: true
            },
            ...(otherCustomer ? [{
              userId: otherCustomer.id,
              userType: 'CUSTOMER',
              isAdmin: false
            }] : []),
            ...(employee ? [{
              userId: employee.id,
              userType: 'EMPLOYEE',
              isAdmin: false
            }] : [])
          ]
        }
      },
      include: {
        participants: true
      }
    });

    console.log('\n✅ Chat created successfully!');
    console.log('Chat ID:', chat.id);
    console.log('Chat Name:', chat.name);
    console.log('Participants:', chat.participants.length);
    console.log('\nUse this chatId in your app:', chat.id);

  } catch (error) {
    console.error('❌ Error creating chat:', error);
  } finally {
    await prisma.$disconnect();
  }
}

createTestChat();
