import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkGroupChats() {
  try {
    console.log('\n🔍 CHECKING GROUP CHATS IN DATABASE...\n');
    
    // Get all chats
    const chats = await prisma.chat.findMany({
      include: {
        participants: {
          include: {
            customer: true,
            employee: true,
          }
        },
        messages: {
          take: 1,
          orderBy: {
            timestamp: 'desc'
          }
        }
      }
    });

    console.log('=' .repeat(80));
    console.log(`📊 FOUND ${chats.length} CHATS IN DATABASE`);
    console.log('=' .repeat(80));

    chats.forEach((chat, index) => {
      console.log(`\n${index + 1}. Chat: ${chat.name || 'Unnamed'}`);
      console.log(`   ID: ${chat.id}`);
      console.log(`   Type: ${chat.type}`);
      console.log(`   Participants: ${chat.participants.length}`);
      console.log(`   Last Message: ${chat.lastMessageAt || 'Never'}`);
      console.log(`   Messages Count: ${chat.messages.length > 0 ? 'Has messages' : 'No messages'}`);
      
      console.log('\n   👥 Participants:');
      chat.participants.forEach((p, i) => {
        const user = p.customer || p.employee;
        const userName = user?.name || 'Unknown';
        const userEmail = user?.email || 'No email';
        console.log(`      ${i + 1}. ${userName} (${userEmail}) - ${p.userType} ${p.isAdmin ? '👑 Admin' : ''}`);
      });
    });

    // Check if alice@test.com is in any chat
    console.log('\n' + '=' .repeat(80));
    console.log('🔍 CHECKING IF alice@test.com IS IN ANY CHAT');
    console.log('=' .repeat(80));

    const alice = await prisma.customer.findUnique({
      where: { email: 'alice@test.com' },
      select: { id: true, name: true }
    });

    if (alice) {
      console.log(`\n✅ Found Alice: ID=${alice.id}, Name=${alice.name}`);
      
      const aliceChats = await prisma.chatParticipant.findMany({
        where: {
          userId: alice.id,
          userType: 'CUSTOMER'
        },
        include: {
          chat: true
        }
      });

      console.log(`\n📊 Alice is in ${aliceChats.length} chat(s):`);
      aliceChats.forEach((cp, i) => {
        console.log(`   ${i + 1}. ${cp.chat.name} (${cp.chat.type}) - Chat ID: ${cp.chat.id}`);
      });

      if (aliceChats.length === 0) {
        console.log('\n⚠️  PROBLEM: Alice is not in any chat!');
        console.log('   Solution: Add Alice to the test group chat');
      }
    } else {
      console.log('\n❌ Alice not found in database!');
    }

    console.log('\n' + '=' .repeat(80));

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkGroupChats();
