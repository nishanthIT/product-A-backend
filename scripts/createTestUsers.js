import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function createTestUsers() {
  try {
    console.log('🚀 Creating test users...\n');

    // Hash the password
    const hashedPassword = await bcrypt.hash('password123', 10);
    console.log('🔒 Password hashed for security\n');

    // Create test customers
    const customers = [
      {
        name: 'Alice Johnson',
        mobile: '+1234567001',
        email: 'alice@test.com',
        password: hashedPassword,
      },
      {
        name: 'Bob Smith',
        mobile: '+1234567002',
        email: 'bob@test.com',
        password: hashedPassword,
      },
      {
        name: 'Charlie Brown',
        mobile: '+1234567003',
        email: 'charlie@test.com',
        password: hashedPassword,
      },
      {
        name: 'Diana Prince',
        mobile: '+1234567004',
        email: 'diana@test.com',
        password: hashedPassword,
      },
      {
        name: 'Eva Green',
        mobile: '+1234567005',
        email: 'eva@test.com',
        password: hashedPassword,
      },
    ];

    // Create test employees
    const employees = [
      {
        name: 'Frank Manager',
        phoneNo: '+1234567101',
        email: 'frank@test.com',
        password: hashedPassword,
      },
      {
        name: 'Grace Supervisor',
        phoneNo: '+1234567102',
        email: 'grace@test.com',
        password: hashedPassword,
      },
      {
        name: 'Henry Assistant',
        phoneNo: '+1234567103',
        email: 'henry@test.com',
        password: hashedPassword,
      },
    ];

    console.log('📝 Creating customers...');
    const createdCustomers = [];
    for (const customer of customers) {
      try {
        const created = await prisma.customer.create({
          data: customer,
        });
        createdCustomers.push(created);
        console.log(`✅ Created customer: ${created.name} (ID: ${created.id})`);
      } catch (error) {
        if (error.code === 'P2002') {
          console.log(`⚠️  Customer ${customer.name} already exists, skipping...`);
          const existing = await prisma.customer.findUnique({
            where: { email: customer.email },
          });
          if (existing) createdCustomers.push(existing);
        } else {
          throw error;
        }
      }
    }

    console.log('\n📝 Creating employees...');
    const createdEmployees = [];
    for (const employee of employees) {
      try {
        const created = await prisma.empolyee.create({
          data: employee,
        });
        createdEmployees.push(created);
        console.log(`✅ Created employee: ${created.name} (ID: ${created.id})`);
      } catch (error) {
        if (error.code === 'P2002') {
          console.log(`⚠️  Employee ${employee.name} already exists, skipping...`);
          const existing = await prisma.empolyee.findUnique({
            where: { email: employee.email },
          });
          if (existing) createdEmployees.push(existing);
        } else {
          throw error;
        }
      }
    }

    console.log('\n' + '='.repeat(70));
    console.log('✅ TEST USERS CREATED SUCCESSFULLY!');
    console.log('='.repeat(70));

    console.log('\n📋 CUSTOMER CREDENTIALS:');
    console.log('─'.repeat(70));
    customers.forEach((customer, index) => {
      console.log(`${index + 1}. Name: ${customer.name}`);
      console.log(`   Email: ${customer.email}`);
      console.log(`   Password: ${customer.password}`);
      console.log(`   Mobile: ${customer.mobile}`);
      console.log('');
    });

    console.log('📋 EMPLOYEE CREDENTIALS:');
    console.log('─'.repeat(70));
    employees.forEach((employee, index) => {
      console.log(`${index + 1}. Name: ${employee.name}`);
      console.log(`   Email: ${employee.email}`);
      console.log(`   Password: ${employee.password}`);
      console.log(`   Mobile: ${employee.phoneNo}`);
      console.log('');
    });

    console.log('='.repeat(70));
    console.log('💡 TIP: Use these credentials to login and test the chat feature!');
    console.log('='.repeat(70));

    // Summary
    console.log('\n📊 SUMMARY:');
    console.log(`   Total Customers: ${createdCustomers.length}`);
    console.log(`   Total Employees: ${createdEmployees.length}`);
    console.log(`   Total Users: ${createdCustomers.length + createdEmployees.length}`);

  } catch (error) {
    console.error('❌ Error creating test users:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

createTestUsers();
