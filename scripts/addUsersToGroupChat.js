import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function addTestUsersToGroupChat() {
  try {
    console.log('\n🚀 Adding test users to group chat...\n');
    
    // Find the test group chat
    const groupChat = await prisma.chat.findFirst({
      where: {
        type: 'GROUP',
        name: 'Test Group Chat'
      }
    });

    if (!groupChat) {
      console.log('❌ Test Group Chat not found!');
      console.log('   Run: node --no-warnings scripts/createTestChat.js');
      return;
    }

    console.log(`✅ Found group chat: ${groupChat.name} (ID: ${groupChat.id})\n`);

    // Get all test customers
    const testCustomers = await prisma.customer.findMany({
      where: {
        email: {
          in: [
            'alice@test.com',
            'bob@test.com',
            'charlie@test.com',
            'diana@test.com',
            'eva@test.com'
          ]
        }
      }
    });

    // Get all test employees
    const testEmployees = await prisma.empolyee.findMany({
      where: {
        email: {
          in: [
            'frank@test.com',
            'grace@test.com',
            'henry@test.com'
          ]
        }
      }
    });

    console.log(`📊 Found ${testCustomers.length} customers and ${testEmployees.length} employees\n`);

    // Add customers to group chat
    console.log('👥 Adding customers to group chat...');
    for (const customer of testCustomers) {
      try {
        await prisma.chatParticipant.create({
          data: {
            chatId: groupChat.id,
            userId: customer.id,
            userType: 'CUSTOMER',
            isAdmin: false
          }
        });
        console.log(`   ✅ Added ${customer.name} (${customer.email})`);
      } catch (error) {
        if (error.code === 'P2002') {
          console.log(`   ⚠️  ${customer.name} already in group chat`);
        } else {
          throw error;
        }
      }
    }

    // Add employees to group chat
    console.log('\n👔 Adding employees to group chat...');
    for (const employee of testEmployees) {
      try {
        await prisma.chatParticipant.create({
          data: {
            chatId: groupChat.id,
            userId: employee.id,
            userType: 'EMPLOYEE',
            isAdmin: false
          }
        });
        console.log(`   ✅ Added ${employee.name} (${employee.email})`);
      } catch (error) {
        if (error.code === 'P2002') {
          console.log(`   ⚠️  ${employee.name} already in group chat`);
        } else {
          throw error;
        }
      }
    }

    // Count total participants
    const totalParticipants = await prisma.chatParticipant.count({
      where: {
        chatId: groupChat.id
      }
    });

    console.log('\n' + '='.repeat(70));
    console.log('✅ ALL TEST USERS ADDED TO GROUP CHAT!');
    console.log('='.repeat(70));
    console.log(`\n📊 Total participants in "${groupChat.name}": ${totalParticipants}`);
    console.log('\n💡 Now login with any test user and you should see the group chat!');
    console.log('='.repeat(70));

  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

addTestUsersToGroupChat();
