import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function testCustomerChats() {
  try {
    // Test Customer details
    const testCustomer = await prisma.customer.findUnique({
      where: { email: 'customer1@example.com' }
    });

    if (!testCustomer) {
      console.log('❌ Test Customer not found!');
      return;
    }

    console.log('✅ Test Customer found:');
    console.log(`   ID: ${testCustomer.id}`);
    console.log(`   Name: ${testCustomer.name}`);
    console.log(`   Email: ${testCustomer.email}\n`);

    // Find chats where Test Customer is a participant
    const chats = await prisma.chat.findMany({
      where: {
        participants: {
          some: {
            userId: testCustomer.id,
            userType: 'CUSTOMER'
          }
        }
      },
      include: {
        participants: {
          include: {
            chat: true
          }
        }
      }
    });

    console.log(`📊 Chats for Test Customer: ${chats.length}\n`);

    for (const chat of chats) {
      console.log(`📝 Chat: ${chat.name || 'Unnamed'}`);
      console.log(`   ID: ${chat.id}`);
      console.log(`   Type: ${chat.type}`);
      console.log(`   Participants: ${chat.participants.length}`);
      console.log('');
    }

    // Check specifically for ALL Chat participation
    const allChatParticipation = await prisma.chatParticipant.findMany({
      where: {
        userId: testCustomer.id,
        userType: 'CUSTOMER',
        chat: {
          name: 'ALL Chat',
          type: 'GROUP'
        }
      },
      include: {
        chat: true
      }
    });

    console.log(`\n🔍 ALL Chat participation: ${allChatParticipation.length}`);
    for (const participation of allChatParticipation) {
      console.log(`   Chat ID: ${participation.chat.id}`);
      console.log(`   Chat Name: ${participation.chat.name}`);
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

testCustomerChats();
