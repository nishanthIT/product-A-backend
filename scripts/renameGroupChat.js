import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function renameGroupChat() {
  try {
    console.log('\n🔄 Renaming ALL group chats...\n');
    
    // Update ALL group chats
    const result = await prisma.chat.updateMany({
      where: {
        type: 'GROUP'
      },
      data: {
        name: 'ALL Chat'
      }
    });

    console.log(`✅ Updated ${result.count} group chat(s) to "ALL Chat"`);
    console.log('\n' + '='.repeat(70));
    console.log('✅ ALL GROUP CHATS RENAMED TO "ALL Chat"!');
    console.log('='.repeat(70));
    console.log('\n💡 Close your app completely and reopen to see the change!');
    console.log('   (Double-tap home and swipe up, then reopen)');

  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

renameGroupChat();
