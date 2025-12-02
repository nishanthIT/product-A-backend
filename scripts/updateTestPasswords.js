import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function updateTestUsersPasswords() {
  try {
    console.log('🔐 Updating test user passwords...\n');

    // Hash the password
    const hashedPassword = await bcrypt.hash('password123', 10);
    console.log('✅ Password "password123" hashed successfully\n');

    // Update customers
    const customerEmails = [
      'alice@test.com',
      'bob@test.com',
      'charlie@test.com',
      'diana@test.com',
      'eva@test.com'
    ];

    console.log('📝 Updating customer passwords...');
    for (const email of customerEmails) {
      try {
        const updated = await prisma.customer.update({
          where: { email },
          data: { password: hashedPassword }
        });
        console.log(`✅ Updated password for customer: ${updated.name} (${email})`);
      } catch (error) {
        if (error.code === 'P2025') {
          console.log(`⚠️  Customer ${email} not found, skipping...`);
        } else {
          throw error;
        }
      }
    }

    // Update employees
    const employeeEmails = [
      'frank@test.com',
      'grace@test.com',
      'henry@test.com'
    ];

    console.log('\n📝 Updating employee passwords...');
    for (const email of employeeEmails) {
      try {
        const updated = await prisma.empolyee.update({
          where: { email },
          data: { password: hashedPassword }
        });
        console.log(`✅ Updated password for employee: ${updated.name} (${email})`);
      } catch (error) {
        if (error.code === 'P2025') {
          console.log(`⚠️  Employee ${email} not found, skipping...`);
        } else {
          throw error;
        }
      }
    }

    console.log('\n' + '='.repeat(70));
    console.log('✅ ALL PASSWORDS UPDATED SUCCESSFULLY!');
    console.log('='.repeat(70));

    console.log('\n🔐 TEST CREDENTIALS (NOW WORKING):');
    console.log('─'.repeat(70));
    console.log('\n📧 CUSTOMERS:');
    customerEmails.forEach((email, index) => {
      const names = ['Alice Johnson', 'Bob Smith', 'Charlie Brown', 'Diana Prince', 'Eva Green'];
      console.log(`${index + 1}. Email: ${email}`);
      console.log(`   Name: ${names[index]}`);
      console.log(`   Password: password123`);
      console.log('');
    });

    console.log('📧 EMPLOYEES:');
    employeeEmails.forEach((email, index) => {
      const names = ['Frank Manager', 'Grace Supervisor', 'Henry Assistant'];
      console.log(`${index + 1}. Email: ${email}`);
      console.log(`   Name: ${names[index]}`);
      console.log(`   Password: password123`);
      console.log('');
    });

    console.log('='.repeat(70));
    console.log('💡 TIP: Login with alice@test.com / password123');
    console.log('='.repeat(70));

  } catch (error) {
    console.error('❌ Error updating passwords:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

updateTestUsersPasswords();
