import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixAllChats() {
  try {
    console.log('🔧 Fixing ALL Chat participants...\n');

    // Find ALL "ALL Chat" groups
    const allChats = await prisma.chat.findMany({
      where: {
        name: 'ALL Chat',
        type: 'GROUP'
      },
      include: {
        participants: true
      }
    });

    console.log(`Found ${allChats.length} "ALL Chat" group(s)\n`);

    // Get all users
    const customers = await prisma.customer.findMany();
    const employees = await prisma.empolyee.findMany();

    console.log(`📊 Total users:`);
    console.log(`   Customers: ${customers.length}`);
    console.log(`   Employees: ${employees.length}\n`);

    // Add all users to each ALL Chat
    for (const chat of allChats) {
      console.log(`\n📝 Processing chat: ${chat.id}`);
      console.log(`   Current participants: ${chat.participants.length}`);

      let added = 0;
      let skipped = 0;

      // Add all customers
      for (const customer of customers) {
        const exists = chat.participants.some(
          p => p.userId === customer.id && p.userType === 'CUSTOMER'
        );

        if (!exists) {
          try {
            await prisma.chatParticipant.create({
              data: {
                chatId: chat.id,
                userId: customer.id,
                userType: 'CUSTOMER',
                isAdmin: false
              }
            });
            console.log(`   ✅ Added ${customer.name}`);
            added++;
          } catch (error) {
            if (error.code === 'P2002') {
              console.log(`   ⚠️  ${customer.name} already exists`);
              skipped++;
            } else {
              throw error;
            }
          }
        } else {
          skipped++;
        }
      }

      // Add all employees
      for (const employee of employees) {
        const exists = chat.participants.some(
          p => p.userId === employee.id && p.userType === 'EMPLOYEE'
        );

        if (!exists) {
          try {
            await prisma.chatParticipant.create({
              data: {
                chatId: chat.id,
                userId: employee.id,
                userType: 'EMPLOYEE',
                isAdmin: false
              }
            });
            console.log(`   ✅ Added ${employee.name}`);
            added++;
          } catch (error) {
            if (error.code === 'P2002') {
              console.log(`   ⚠️  ${employee.name} already exists`);
              skipped++;
            } else {
              throw error;
            }
          }
        } else {
          skipped++;
        }
      }

      // Get updated count
      const updatedChat = await prisma.chat.findUnique({
        where: { id: chat.id },
        include: { participants: true }
      });

      console.log(`\n   📊 Results for chat ${chat.id}:`);
      console.log(`      Newly added: ${added}`);
      console.log(`      Already existed: ${skipped}`);
      console.log(`      Total participants now: ${updatedChat.participants.length}`);
    }

    console.log('\n\n✅ ALL users added to ALL "ALL Chat" groups!');

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

fixAllChats();
