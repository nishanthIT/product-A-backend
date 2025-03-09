import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function createInitialAdminUser() {
  try {
    // Check if an admin already exists
    const existingAdmin = await prisma.admin.findFirst({
      where: { email: 'admin@gmail.com' }
    });
    if (existingAdmin) {
      console.log('Admin user already exists');
      return;
    }

    // Generate a secure password
    const plainTextPassword = 'Vino@123';
    const hashedPassword = await bcrypt.hash(plainTextPassword, 10);

    // Create the initial admin user
    const newAdmin = await prisma.admin.create({
      data: {
        email: 'admin@gmail.com',
        password: hashedPassword,
        userType: 'ADMIN'
      }
    });

    console.log('Initial admin user created successfully');
    console.log('Email:', newAdmin.email);
    console.log('Temporary Password:', plainTextPassword);
  } catch (error) {
    console.error('Error creating initial admin user:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
createInitialAdminUser();