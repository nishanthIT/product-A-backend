import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkParticipants() {
  try {
    console.log('🔍 Checking ALL Chat participants...\n');

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
    console.log(`📊 Total participants: ${allChat.participants.length}\n`);

    // Get all customers
    const customers = await prisma.customer.findMany();
    console.log(`📋 Total customers in database: ${customers.length}`);
    
    // Check each customer
    for (const customer of customers) {
      const isParticipant = allChat.participants.some(
        p => p.userId === customer.id && p.userType === 'CUSTOMER'
      );
      console.log(`${isParticipant ? '✅' : '❌'} ${customer.name} (${customer.email}) - ID: ${customer.id}`);
    }

    console.log('\n');

    // Get all employees
    const employees = await prisma.empolyee.findMany();
    console.log(`📋 Total employees in database: ${employees.length}`);
    
    // Check each employee
    for (const employee of employees) {
      const isParticipant = allChat.participants.some(
        p => p.userId === employee.id && p.userType === 'EMPLOYEE'
      );
      console.log(`${isParticipant ? '✅' : '❌'} ${employee.name} (${employee.email}) - ID: ${employee.id}`);
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkParticipants();
