import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function ensureAllUsersInAllChat() {
  try {
    console.log('\n🔍 Checking ALL Chat participants...\n');
    
    // Find ALL Chat
    const allChat = await prisma.chat.findFirst({
      where: {
        name: 'ALL Chat',
        type: 'GROUP'
      },
      include: {
        participants: true
      }
    });

    if (!allChat) {
      console.log('❌ ALL Chat not found!');
      return;
    }

    console.log(`✅ Found ALL Chat (ID: ${allChat.id})`);
    console.log(`   Current participants: ${allChat.participants.length}\n`);

    // Get ALL customers
    const allCustomers = await prisma.customer.findMany({
      select: { id: true, name: true, email: true }
    });

    // Get ALL employees
    const allEmployees = await prisma.empolyee.findMany({
      select: { id: true, name: true, email: true }
    });

    console.log(`📊 Total users in database:`);
    console.log(`   Customers: ${allCustomers.length}`);
    console.log(`   Employees: ${allEmployees.length}\n`);

    let added = 0;

    // Add ALL customers
    console.log('👥 Adding customers to ALL Chat...');
    for (const customer of allCustomers) {
      try {
        await prisma.chatParticipant.create({
          data: {
            chatId: allChat.id,
            userId: customer.id,
            userType: 'CUSTOMER',
            isAdmin: false
          }
        });
        console.log(`   ✅ Added ${customer.name} (${customer.email})`);
        added++;
      } catch (error) {
        if (error.code === 'P2002') {
          console.log(`   ⚠️  ${customer.name} already in chat`);
        } else {
          console.error(`   ❌ Error adding ${customer.name}:`, error.message);
        }
      }
    }

    // Add ALL employees
    console.log('\n👔 Adding employees to ALL Chat...');
    for (const employee of allEmployees) {
      try {
        await prisma.chatParticipant.create({
          data: {
            chatId: allChat.id,
            userId: employee.id,
            userType: 'EMPLOYEE',
            isAdmin: false
          }
        });
        console.log(`   ✅ Added ${employee.name} (${employee.email})`);
        added++;
      } catch (error) {
        if (error.code === 'P2002') {
          console.log(`   ⚠️  ${employee.name} already in chat`);
        } else {
          console.error(`   ❌ Error adding ${employee.name}:`, error.message);
        }
      }
    }

    // Get final count
    const finalCount = await prisma.chatParticipant.count({
      where: { chatId: allChat.id }
    });

    console.log('\n' + '='.repeat(70));
    console.log('✅ ALL USERS ADDED TO "ALL Chat"!');
    console.log('='.repeat(70));
    console.log(`\n📊 Summary:`);
    console.log(`   Total users in database: ${allCustomers.length + allEmployees.length}`);
    console.log(`   Users in ALL Chat: ${finalCount}`);
    console.log(`   Newly added: ${added}`);
    console.log('\n💡 Now everyone can access ALL Chat!');
    console.log('='.repeat(70));

  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

ensureAllUsersInAllChat();
