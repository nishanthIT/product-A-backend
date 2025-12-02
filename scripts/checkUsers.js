import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkUsers() {
  try {
    console.log('\n🔍 CHECKING DATABASE USERS...\n');
    
    const customers = await prisma.customer.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        mobile: true,
        password: true,
      }
    });
    
    const employees = await prisma.empolyee.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        phoneNo: true,
        password: true,
      }
    });

    console.log('=' .repeat(80));
    console.log('👥 CUSTOMERS IN DATABASE:');
    console.log('=' .repeat(80));
    customers.forEach((customer, index) => {
      console.log(`\n${index + 1}. ${customer.name}`);
      console.log(`   📧 Email: ${customer.email}`);
      console.log(`   🔑 Password: ${customer.password}`);
      console.log(`   📱 Mobile: ${customer.mobile}`);
      console.log(`   🆔 ID: ${customer.id}`);
    });

    console.log('\n' + '=' .repeat(80));
    console.log('👔 EMPLOYEES IN DATABASE:');
    console.log('=' .repeat(80));
    employees.forEach((employee, index) => {
      console.log(`\n${index + 1}. ${employee.name}`);
      console.log(`   📧 Email: ${employee.email}`);
      console.log(`   🔑 Password: ${employee.password}`);
      console.log(`   📱 Mobile: ${employee.phoneNo}`);
      console.log(`   🆔 ID: ${employee.id}`);
    });

    console.log('\n' + '=' .repeat(80));
    console.log(`📊 TOTAL: ${customers.length} customers + ${employees.length} employees = ${customers.length + employees.length} users`);
    console.log('=' .repeat(80));

    console.log('\n💡 LOGIN INSTRUCTIONS:');
    console.log('   1. Use EMAIL and PASSWORD from above');
    console.log('   2. Open your app and go to Login screen');
    console.log('   3. Enter credentials exactly as shown');
    console.log('   4. Select user type: CUSTOMER or EMPLOYEE\n');

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkUsers();
